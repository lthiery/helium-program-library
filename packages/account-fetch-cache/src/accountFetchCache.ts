import {
  AccountInfo,
  Commitment,
  Connection,
  PublicKey,
  SendOptions,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { EventEmitter } from "./eventEmitter";
import { getMultipleAccounts } from "./getMultipleAccounts";

export const DEFAULT_CHUNK_SIZE = 99;
export const DEFAULT_DELAY = 50;

export type TypedAccountParser<T> = (
  pubkey: PublicKey,
  data: AccountInfo<Buffer>
) => T;

export interface ParsedAccountBase<T> {
  pubkey: PublicKey;
  account: AccountInfo<Buffer>;
  info?: T;
}

export type AccountParser<T> = (
  pubkey: PublicKey,
  data: AccountInfo<Buffer>
) => ParsedAccountBase<T> | undefined;

function getWriteableAccounts(
  instructions: TransactionInstruction[]
): PublicKey[] {
  return instructions
    .flatMap((i) => i.keys)
    .filter((k) => k.isWritable)
    .map((a) => a.pubkey);
}

let id = 0;

let singletons: Record<string, AccountFetchCache | undefined> = {};
export function getSingleton(conn: Connection): AccountFetchCache {
  const commitment = conn.commitment || "confirmed";
  const endp = conn.rpcEndpoint;
  if (!singletons[endp + commitment]) {
    singletons[endp + commitment] = new AccountFetchCache({
      connection: conn,
      commitment,
    });
  }
  return singletons[endp + commitment]!;
}

function setSingleton(conn: Connection, cache: AccountFetchCache) {
  const commitment = conn.commitment || "confirmed";
  const endp = conn.rpcEndpoint;
  singletons[endp + commitment] = cache;
}

export interface AccountCache {
  delete(key: string): void;
  has(key: string): boolean;
  get(key: string): ParsedAccountBase<unknown> | null | undefined;
  set(key: string, value: ParsedAccountBase<unknown> | null): void;
}

export class MapAccountCache implements AccountCache {
  cache = new Map<string, ParsedAccountBase<unknown> | null>() as AccountCache;

  delete(key: string): void {
    this.cache.delete(key);
  }
  has(key: string): boolean {
    return this.cache.has(key);
  }
  get(key: string): ParsedAccountBase<unknown> | null | undefined {
    return this.cache.get(key);
  }
  set(key: string, value: ParsedAccountBase<unknown> | null): void {
    this.cache.set(key, value);
  }
}

export class AccountFetchCache {
  enableLogging: boolean;
  connection: Connection;
  chunkSize: number;
  delay: number;
  commitment: Commitment;
  accountWatchersCount = new Map<string, number>();
  accountChangeListeners = new Map<string, number>();
  statics = new Set<string>();
  missingAccounts = new Map<string, AccountParser<unknown> | undefined>();
  genericCache: AccountCache;
  keyToAccountParser = new Map<string, AccountParser<unknown> | undefined>();
  timeout: NodeJS.Timeout | null = null;
  currentBatch = new Set<string>();
  pendingCallbacks = new Map<
    string,
    (info: AccountInfo<Buffer> | null, err: Error | null) => void
  >();
  pendingCalls = new Map<string, Promise<ParsedAccountBase<unknown>>>();
  emitter = new EventEmitter();
  id: number; // For debugging, to see which cache is being used

  oldGetAccountinfo?: (
    publicKey: PublicKey,
    com?: Commitment
  ) => Promise<AccountInfo<Buffer> | null>;
  oldSendTransaction: (...args: any[]) => Promise<string>;
  oldSendRawTransaction: (
    rawTransaction: Buffer | Uint8Array | Array<number>,
    options?: SendOptions
  ) => Promise<string>;

  missingInterval: NodeJS.Timeout;

  constructor({
    connection,
    chunkSize = DEFAULT_CHUNK_SIZE,
    delay = DEFAULT_DELAY,
    commitment,
    missingRefetchDelay = 10000,
    extendConnection = false,
    cache,
    enableLogging = false,
  }: {
    connection: Connection;
    chunkSize?: number;
    delay?: number;
    commitment: Commitment;
    missingRefetchDelay?: number;
    /** Add functionatility to getAccountInfo that uses the cache */
    extendConnection?: boolean;
    cache?: AccountCache;
    enableLogging?: boolean;
  }) {
    this.enableLogging = enableLogging;
    this.genericCache = cache || new MapAccountCache();

    this.id = ++id;
    this.connection = connection;
    this.chunkSize = chunkSize;
    this.delay = delay;
    this.commitment = commitment;
    this.missingInterval = setInterval(
      this.fetchMissing.bind(this),
      missingRefetchDelay
    );

    this.oldSendTransaction = connection.sendTransaction.bind(connection);
    this.oldSendRawTransaction = connection.sendRawTransaction.bind(connection);

    const self = this;

    // @ts-ignore
    if (extendConnection && !connection._accountFetchWrapped) {
      // @ts-ignore
      connection._accountFetchWrapped = true;
      this.oldGetAccountinfo = connection.getAccountInfo.bind(connection);

      connection.getAccountInfo = async (
        publicKey: PublicKey,
        com?: Commitment
      ): Promise<AccountInfo<Buffer> | null> => {
        if (
          (com || connection.commitment) == commitment ||
          typeof (com || connection.commitment) == "undefined"
        ) {
          const [result, dispose] = await this.searchAndWatch(publicKey);
          setTimeout(dispose, 30 * 1000); // cache for 30s
          return result?.account || null;
        }

        return self.oldGetAccountinfo!(publicKey, com);
      };
    }
    connection.sendTransaction = async function overloadedSendTransaction(
      ...args: any[]
    ) {
      const result = await self.oldSendTransaction(...args);

      this.confirmTransaction(result, "finalized")
        .then(() => {
          return self.requeryMissing(args[0].instructions);
        })
        .catch(console.error);
      return result;
    };

    connection.sendRawTransaction = async function overloadedSendRawTransaction(
      rawTransaction: Buffer | Uint8Array | Array<number>,
      options?: SendOptions
    ) {
      const result = await self.oldSendRawTransaction(rawTransaction, options);

      try {
        const instructions = Transaction.from(rawTransaction).instructions;

        this.confirmTransaction(result, "finalized")
          .then(() => {
            return self.requeryMissing(instructions);
          })
          .catch(console.error);
      } catch (e: any) {
        // TODO: handle transaction v2
      }

      return result;
    };

    setSingleton(connection, this);
  }

  async requeryMissing(instructions: TransactionInstruction[]) {
    const writeableAccounts = getWriteableAccounts(instructions).map((a) =>
      a.toBase58()
    );
    await Promise.all(
      writeableAccounts.map(async (account) => {
        const parser = this.missingAccounts.get(account);
        const [found, dispose] = await this.searchAndWatch(
          new PublicKey(account),
          parser,
          this.statics.has(account),
          true
        );
        dispose();
        if (found) {
          this.missingAccounts.delete(account);
        }
      })
    );
  }

  async fetchMissing() {
    try {
      await Promise.all(
        [...this.missingAccounts].map(
          ([account, _]) =>
            this.searchAndWatch(
              new PublicKey(account),
              this.missingAccounts.get(account),
              this.statics.has(account),
              true
            ).then(([_, dispose]) => dispose()) // Dispose immediately, this isn't watching.
        )
      );
    } catch (e) {
      // This happens in an interval, so just log errors
      console.error(e);
    }
  }

  close() {
    if (this.oldGetAccountinfo) {
      this.connection.getAccountInfo = this.oldGetAccountinfo;
    }
    this.connection.sendTransaction = this.oldSendTransaction;
    this.connection.sendRawTransaction = this.oldSendRawTransaction;
    clearInterval(this.missingInterval);
  }

  async fetchBatch() {
    const currentBatch = this.currentBatch;
    this.currentBatch = new Set(); // Erase current batch from state, so we can fetch multiple at a time
    if (this.enableLogging) {
      console.log(`Fetching batch of ${currentBatch.size} accounts`);
    }
    try {
      const keys = Array.from(currentBatch);
      const { array } = await getMultipleAccounts(
        this.connection,
        keys,
        this.commitment
      );
      keys.forEach((key, index) => {
        const callback = this.pendingCallbacks.get(key);
        callback && callback(array[index], null);
      });

      return { keys, array };
    } catch (e: any) {
      currentBatch.forEach((key) => {
        const callback = this.pendingCallbacks.get(key);
        callback && callback(null, e);
      });
      throw e;
    }
  }

  addToBatchIgnoreResult(id: PublicKey) {
    const idStr = id.toBase58();

    this.currentBatch.add(idStr);

    this.timeout != null && clearTimeout(this.timeout);
    if (this.currentBatch.size > DEFAULT_CHUNK_SIZE) {
      return this.fetchBatch();
    } else {
      this.timeout = setTimeout(() => this.fetchBatch(), this.delay);
    }
    return undefined;
  }

  async addToBatch(id: PublicKey): Promise<AccountInfo<Buffer>> {
    const idStr = id.toBase58();

    this.currentBatch.add(idStr);

    this.timeout != null && clearTimeout(this.timeout);
    if (this.currentBatch.size > DEFAULT_CHUNK_SIZE) {
      this.fetchBatch();
    } else {
      this.timeout = setTimeout(() => this.fetchBatch(), this.delay);
    }

    const promise = new Promise<AccountInfo<Buffer>>((resolve, reject) => {
      this.pendingCallbacks.set(idStr, (info, err) => {
        this.pendingCallbacks.delete(idStr);
        if (err) {
          return reject(err);
        }
        resolve(info!);
      });
    });

    return promise;
  }

  async flush() {
    this.timeout && clearTimeout(this.timeout);
    await this.fetchBatch();
  }

  async searchAndWatch<T>(
    pubKey: string | PublicKey,
    parser?: AccountParser<T> | undefined,
    isStatic: Boolean = false, // optimization, set if the data will never change
    forceRequery = false
  ): Promise<[ParsedAccountBase<T> | undefined, () => void]> {
    let id: PublicKey;
    if (typeof pubKey === "string") {
      id = new PublicKey(pubKey);
    } else {
      id = pubKey;
    }
    if (!pubKey) {
      return [undefined, () => {}];
    }

    const address = id.toBase58();

    const data = await this.search(pubKey, parser, isStatic, forceRequery);
    const dispose = this.watch(id, parser, !!data);
    const cacheEntry = this.genericCache.get(address);
    if (!this.genericCache.has(address) || cacheEntry != data) {
      this.updateCacheAndRaiseUpdated<T>(address, data || null);
    }

    return [data, dispose];
  }

  updateCache<T>(id: string, data: ParsedAccountBase<T> | null) {
    this.genericCache.set(id, data || null);
  }

  async updateCacheAndRaiseUpdated<T>(
    id: string,
    data: ParsedAccountBase<T> | null
  ) {
    const isNew = !this.genericCache.has(id);
    this.updateCache(id, data);

    this.emitter.raiseCacheUpdated(id, isNew, this.keyToAccountParser.get(id));
  }

  static defaultParser: AccountParser<any> = (pubkey, account) => ({
    pubkey,
    account,
  });

  // The same as query, except swallows errors and returns undefined.
  async search<T>(
    pubKey: string | PublicKey,
    parser?: AccountParser<T> | undefined,
    isStatic: Boolean = false, // optimization, set if the data will never change
    forceRequery = false
  ): Promise<ParsedAccountBase<T> | undefined> {
    let id: PublicKey;
    if (typeof pubKey === "string") {
      id = new PublicKey(pubKey);
    } else {
      id = pubKey;
    }

    this.registerParser(id, parser);

    const address = id.toBase58();
    if (isStatic) {
      this.statics.add(address);
    } else if (this.statics.has(address)) {
      this.statics.delete(address); // If trying to use this as not static, need to rm it from the statics list.
    }

    if (!forceRequery && this.genericCache.has(address)) {
      const result = this.genericCache.get(address);
      return result == null
        ? undefined
        : (result as ParsedAccountBase<T> | undefined);
    }

    const existingQuery = this.pendingCalls.get(address) as Promise<
      ParsedAccountBase<T>
    >;
    if (!forceRequery && existingQuery) {
      return existingQuery;
    }
    const query = this.addToBatch(id).then((data) => {
      this.pendingCalls.delete(address);
      if (!data) {
        return undefined;
      }

      const result = this.getParsed(id, data, parser) || {
        pubkey: id,
        account: data,
        info: undefined,
      };

      // Only set the cache for defined static accounts. Static accounts can change if they go from nonexistant to existant.
      // Rely on searchAndWatch to set the generic cache for everything else.
      // Never update the cache with an account that isn't being watched. This could cause
      // stale data to be returned.
      if (isStatic && result && result.info) {
        this.updateCacheAndRaiseUpdated(address, result);
      }

      return result;
    });
    this.pendingCalls.set(address, query as any);

    return query;
  }

  async searchMultiple<T>(
    pubKeys: PublicKey[],
    parser?: AccountParser<T> | undefined,
    isStatic: Boolean = false, // optimization, set if the data will never change
    forceRequery = false
  ): Promise<(ParsedAccountBase<T> | undefined)[]> {
    // Store results of batch fetches in this map. If isStatic is false, genericCache will have none of the
    // results of our searches in the batch. So need to accumulate them here
    const result: Record<string, ParsedAccountBase<T>> = {};
    const searched = new Set(pubKeys.map((p) => p.toBase58()));
    for (const key of pubKeys) {
      this.registerParser(key, parser);
      const address = key.toBase58();
      if (isStatic) {
        this.statics.add(address);
      } else if (this.statics.has(address)) {
        this.statics.delete(address); // If trying to use this as not static, need to rm it from the statics list.
      }

      if (forceRequery || !this.genericCache.has(address)) {
        const { keys, array } = (await this.addToBatchIgnoreResult(key)) || {
          keys: [],
          array: [],
        };

        keys.forEach((key, index) => {
          this.statics.add(key);
          if (searched.has(key)) {
            const item = array[index];
            if (item) {
              const parsed = this.getParsed(key, item, parser) || null;
              // Cache these results if they aren't going to change
              if (isStatic) {
                this.updateCache(key, parsed);
              }
              if (parsed) {
                result[key] = parsed;
              }
            }
          }
        });
      }
    }

    // Force a batch fetch to resolve all accounts
    const { keys, array } = await this.fetchBatch();
    keys.forEach((key, index) => {
      this.statics.add(key);
      if (searched.has(key)) {
        const item = array[index];
        if (item) {
          const parsed = this.getParsed(key, item, parser) || null;
          // Cache these results if they aren't going to change
          if (isStatic) {
            this.updateCache(key, parsed);
          }
          if (parsed) {
            result[key] = parsed;
          }
        }
      }
    });

    return pubKeys.map(
      (key) =>
        result[key.toBase58()] ||
        (this.genericCache.get(key.toBase58()) as
          | ParsedAccountBase<T>
          | undefined)
    );
  }

  onAccountChange<T>(
    key: PublicKey,
    parser: AccountParser<T> | undefined,
    account: AccountInfo<Buffer>
  ) {
    try {
      const parsed = this.getParsed(key, account, parser);
      const address = key.toBase58();
      this.updateCacheAndRaiseUpdated(address, parsed || null);
    } catch (e: any) {
      console.error("accountFetchCache", "Failed to update account", e);
    }
  }

  watch<T>(
    id: PublicKey,
    parser?: AccountParser<T> | undefined,
    exists: Boolean = true
  ): () => void {
    const address = id.toBase58();
    const isStatic = this.statics.has(address);
    let oldCount = (this.accountWatchersCount.get(address) || 0) + 1;
    this.accountWatchersCount.set(address, oldCount);

    if (exists && !isStatic) {
      // Only websocket watch accounts that exist
      // Don't recreate listeners
      // xNFT doesn't support onAccountChange, so we have to make a new usable connection.
      if (!this.accountChangeListeners.has(address)) {
        try {
          this.accountChangeListeners.set(
            address,
            this.connection.onAccountChange(
              id,
              (account) => this.onAccountChange(id, undefined, account),
              this.commitment
            )
          );
        } catch (e: any) {
          if (e.toString().includes("not implemented")) {
            // @ts-ignore
            this.usableConnection =
              // @ts-ignore
              this.usableConnection ||
              new Connection(
                // @ts-ignore
                this.connection._rpcEndpoint,
                this.commitment
              );
            this.accountChangeListeners.set(
              address,
              // @ts-ignore
              this.usableConnection.onAccountChange(
                id,
                // @ts-ignore
                (account) => this.onAccountChange(id, undefined, account),
                this.commitment
              )
            );
          } else {
            console.error(e);
            throw e;
          }
        }
      }
    } else if (!exists) {
      // Poll accounts that don't exist
      this.missingAccounts.set(
        address,
        parser || this.missingAccounts.get(address)
      );
    }

    return () => {
      const newCount = this.accountWatchersCount.get(address)! - 1;
      this.accountWatchersCount.set(address, newCount);

      if (newCount <= 0) {
        const subscriptionId = this.accountChangeListeners.get(address);
        if (subscriptionId) {
          this.accountChangeListeners.delete(address);
          try {
            this.connection.removeAccountChangeListener(subscriptionId);
          } catch (e: any) {
            if (e.toString().includes("not implemented")) {
              // @ts-ignore
              this.usableConnection.removeAccountChangeListener(subscriptionId);
            }
          }
        }
        this.missingAccounts.delete(address);
      }
    };
  }

  async query<T>(
    pubKey: string | PublicKey,
    parser?: AccountParser<T>
  ): Promise<ParsedAccountBase<T>> {
    const ret = await this.search(pubKey, parser);
    if (!ret) {
      throw new Error("Account not found");
    }

    return ret;
  }

  getParsed<T>(
    id: PublicKey | string,
    obj: AccountInfo<Buffer>,
    parser?: AccountParser<T>
  ): ParsedAccountBase<T> | undefined {
    const address = typeof id === "string" ? id : id?.toBase58();
    this.registerParser(id, parser);
    const deserialize = (this.keyToAccountParser.get(address) ||
      AccountFetchCache.defaultParser) as AccountParser<T>;
    const account = deserialize(new PublicKey(address), obj);
    if (!account) {
      return {
        pubkey: new PublicKey(id),
        account: obj,
      };
    }

    return account;
  }

  get(pubKey: string | PublicKey) {
    let key: string;
    if (typeof pubKey !== "string") {
      key = pubKey.toBase58();
    } else {
      key = pubKey;
    }

    return this.genericCache.get(key);
  }

  delete(pubKey: string | PublicKey) {
    let key: string;
    if (typeof pubKey !== "string") {
      key = pubKey.toBase58();
    } else {
      key = pubKey;
    }

    const subId = this.accountChangeListeners.get(key);
    if (subId) {
      this.connection.removeAccountChangeListener(subId);
      this.accountChangeListeners.delete(key);
    }

    if (this.genericCache.has(key)) {
      this.genericCache.delete(key);
      this.emitter.raiseCacheDeleted(key);
      return true;
    }
    return false;
  }

  byParser<T>(parser: AccountParser<T>) {
    const result: string[] = [];
    for (const id of this.keyToAccountParser.keys()) {
      if (this.keyToAccountParser.get(id) === parser) {
        result.push(id);
      }
    }

    return result;
  }

  registerParser<T>(
    pubkey: PublicKey | string,
    parser: AccountParser<T> | undefined
  ) {
    if (pubkey) {
      const address = typeof pubkey === "string" ? pubkey : pubkey?.toBase58();
      if (parser && !this.keyToAccountParser.get(address)) {
        this.keyToAccountParser.set(address, parser);
        const cached = this.genericCache.get(address);
        if (cached) {
          const parsed = parser(cached.pubkey, cached.account);
          if (parsed) {
            this.updateCache(address, parsed);
          }
        }
      }
    }

    return pubkey;
  }
}
