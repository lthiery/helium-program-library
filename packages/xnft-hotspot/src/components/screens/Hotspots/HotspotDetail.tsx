import { FC, useState } from "react";
import {
  View,
  Image,
  Text,
  Button,
  Loading,
  usePublicKey,
  useConnection,
} from "react-xnft";
import { PublicKey, Transaction } from "@solana/web3.js";
import * as anchor from "@project-serum/anchor";
import { init } from "@helium/lazy-distributor-sdk";
import * as client from "@helium/distributor-oracle";
import ky from "ky";
import classnames from "classnames";
import { LAZY_KEY } from "../../../utils";
import { useNotification } from "../../../contexts/notification";
import { useTitleColor } from "../../../utils/hooks";

interface HotspotDetailScreenProps {
  nft: any; // TODO: actually type this
  pendingRewards: any; // TODO: actually type this
  symbol: string;
}

export const HotspotDetailScreen: FC<HotspotDetailScreenProps> = ({
  nft,
  pendingRewards,
  symbol,
}) => {
  useTitleColor();
  const publicKey = usePublicKey();
  const connection = useConnection();
  const [txLoading, setLoading] = useState<boolean>(false);
  const { setMessage } = useNotification();
  const hasRewards = pendingRewards && pendingRewards > 0;

  const claimRewards = async () => {
    if (txLoading) return;
    setLoading(true);
    try {
      const stubProvider = new anchor.AnchorProvider(
        connection,
        //@ts-ignore
        { publicKey },
        anchor.AnchorProvider.defaultOptions()
      );
      const program = await init(stubProvider);
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
      setLoading(false);
      setMessage("Transaction confirmed", "success");
    } catch (err) {
      setLoading(false);
      setMessage(`Transaction failed: ${err.message}`, "error");
    }
  };

  return (
    <View tw="flex flex-col px-5">
      <View tw="flex rounded-md p-4 mb-2 bg-zinc-300 dark:bg-zinc-900">
        <Image tw="w-full rounded-md" src={nft.tokenMetaUriData.image} />
      </View>

      <View tw="flex flex-col px-1">
        <Text tw="text-lg font-bold !m-0 text-zinc-900 dark:text-zinc-200">
          {nft.tokenMetaUriData.name}
        </Text>
        <View tw="flex flex-row items-center">
          <Text tw="text-md font-bold !m-0 text-zinc-900 dark:text-zinc-200">
            Pending rewards:&nbsp;
          </Text>
          <Text tw="text-sm !m-0 text-zinc-600 dark:text-zinc-400">
            {pendingRewards || "0"} {symbol || ""}
          </Text>
        </View>

        <View tw="flex flex-row items-center">
          <Text tw="text-md font-bold !m-0 text-zinc-900 dark:text-zinc-200">
            Description:&nbsp;
          </Text>
          <Text tw="text-sm !m-0 text-zinc-600 dark:text-zinc-400">
            {nft.tokenMetaUriData.description}
          </Text>
        </View>
      </View>

      <View tw="flex flex-row mt-5 mb-5">
        <Button
          tw={classnames(
            "h-12 w-full text-white font-bold text-md border-0 rounded-md",
            { "bg-green-500": hasRewards },
            { "bg-green-500/[0.5]": !hasRewards },
            { "hover:bg-green-600": hasRewards }
          )}
          onClick={hasRewards ? () => claimRewards() : () => {}}
        >
          {hasRewards ? `Claim rewards` : `No rewards to claim`}
          {txLoading && (
            <Loading
              style={{
                display: "block",
                marginLeft: "auto",
                marginRight: "auto",
              }}
            />
          )}
        </Button>
      </View>
    </View>
  );
};
