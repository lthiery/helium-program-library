import React, { FC } from "react";
import { View, Button, usePublicKey, useConnection } from "react-xnft";
import * as anchor from "@project-serum/anchor";
import { PublicKey, Transaction } from "@solana/web3.js";
import { init } from "@helium/lazy-distributor-sdk";
import * as client from "@helium/distributor-oracle";
import ky from "ky";
import { HotspotGridItem } from "./HotspotGridItem";
import { LAZY_KEY, useTokenAccounts } from "../../../../utils/index";
import { LoadingIndicator } from "../../../common";
import { useTitleColor } from "../../../../utils/hooks";

interface HotspotGridScreenProps {}

export const HotspotGridScreen: FC<HotspotGridScreenProps> = () => {
  useTitleColor();
  const tokenAccounts = useTokenAccounts();
  const publicKey = usePublicKey();
  const connection = useConnection();

  if (!tokenAccounts) return <LoadingIndicator />;

  const claimAllRewards = async () => {
    //@ts-ignore
    const stubProvider = new anchor.AnchorProvider(
      connection,
      //@ts-ignore
      { publicKey },
      anchor.AnchorProvider.defaultOptions()
    );
    const program = await init(stubProvider);

    for (const nft of tokenAccounts) {
      const rewards = await client.getCurrentRewards(
        program,
        LAZY_KEY,
        new PublicKey(nft.metadata.mint)
      );
      const tx = await client.formTransaction(
        program,
        //@ts-ignore
        window.xnft.solana,
        rewards,
        new PublicKey(nft.metadata.mint),
        LAZY_KEY,
        publicKey
      );

      const serializedTx = tx.serialize({
        requireAllSignatures: false,
        verifySignatures: false,
      });

      const res = await ky.post("http://localhost:8080/", {
        json: { transaction: serializedTx },
      });

      const json = (await res.json()) as any;
      const signedTx = Transaction.from(json!.transaction!.data);
      //@ts-ignore
      await window.xnft.solana.send(signedTx, [], { skipPreflight: true });
    }
  };

  return (
    <View tw="flex flex-col">
      <View tw="flex flex-row flex-wrap justify-between px-5 mb-5">
        {tokenAccounts.map((nft) => (
          <HotspotGridItem key={nft.metadata.mint} nft={nft} />
        ))}
      </View>
      <View tw="flex w-full justify-center sticky bottom-0 px-5 mb-5 bg-green-400 dark:bg-zinc-800">
        <Button
          tw="h-12 w-full text-white font-bold text-md border-0 rounded-md bg-green-500 hover:bg-green-600"
          onClick={() => claimAllRewards()}
        >
          Claim all rewards
        </Button>
      </View>
    </View>
  );
};
