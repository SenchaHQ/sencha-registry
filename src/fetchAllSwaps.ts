import { SignerWallet, SolanaProvider } from "@saberhq/solana-contrib";
import { deserializeMint } from "@saberhq/token-utils";
import type { SwapInfoData } from "@senchahq/sencha-sdk";
import { SenchaSDK } from "@senchahq/sencha-sdk";
import { StaticTokenListResolutionStrategy } from "@solana/spl-token-registry";
import type { AccountInfo, PublicKey } from "@solana/web3.js";
import { Connection, Keypair } from "@solana/web3.js";
import * as fs from "fs/promises";
import { chunk, zip } from "lodash";

const TOKEN_LIST = new StaticTokenListResolutionStrategy().resolve();

const MAX_CHUNK = 100;

export const fetchAllSwaps = async (): Promise<void> => {
  const provider = SolanaProvider.load({
    connection: new Connection("https://sencha.rpcpool.com"),
    wallet: new SignerWallet(Keypair.generate()),
  });

  const getMultipleAccountsInfoChunked = async (keys: PublicKey[]) => {
    const keyChunks = chunk(keys, MAX_CHUNK);
    return (
      await Promise.all(
        keyChunks.map(async (c) => {
          return await sencha.provider.connection.getMultipleAccountsInfo(c);
        })
      )
    ).flat();
  };

  const sencha = SenchaSDK.load({ provider });
  const metas = await sencha.loadFactory().fetchAllSwapMetas();
  const swaps = await getMultipleAccountsInfoChunked(metas.map((m) => m.swap));

  const swapInfos = swaps
    .filter((s): s is AccountInfo<Buffer> => !!s)
    .map((s) =>
      sencha.programs.CpAmm.coder.accounts.decode<SwapInfoData>(
        "SwapInfo",
        s.data
      )
    );

  const mintKeys = swapInfos.map((swap) => swap.poolMint);
  const mints = zip(
    mintKeys,
    (await getMultipleAccountsInfoChunked(mintKeys)).map((s) =>
      s ? deserializeMint(s.data) : null
    )
  );

  const accounts: { coingeckoId: string; account: PublicKey }[] = [];
  const unknownAccounts: { mint: PublicKey; account: PublicKey }[] = [];

  const pushToken = ({
    coingeckoId,
    mint,
    reserves,
  }: {
    coingeckoId?: string;
    mint: PublicKey;
    reserves: PublicKey;
  }) => {
    if (!coingeckoId) {
      // treat CASH as USDC for accounting purposes
      if (mint.toString() === "CASHVDm2wsJXfhj6VWxb7GiMdoLc17Du7paH4bNr5woT") {
        coingeckoId = "usd-coin";
      }
    }
    if (coingeckoId) {
      accounts.push({
        coingeckoId,
        account: reserves,
      });
    } else {
      unknownAccounts.push({
        mint,
        account: reserves,
      });
    }
  };

  swapInfos.forEach((swap) => {
    const token0 = TOKEN_LIST.find(
      (tok) => tok.address === swap.token0.mint.toString()
    );
    const token1 = TOKEN_LIST.find(
      (tok) => tok.address === swap.token1.mint.toString()
    );

    pushToken({
      coingeckoId: token0?.extensions?.coingeckoId,
      mint: swap.token0.mint,
      reserves: swap.token0.reserves,
    });
    pushToken({
      coingeckoId: token1?.extensions?.coingeckoId,
      mint: swap.token1.mint,
      reserves: swap.token1.reserves,
    });
  });

  await fs.mkdir("data/", { recursive: true });
  await fs.writeFile(
    "data/swaps.json",
    JSON.stringify(
      swapInfos
        .map((s) => {
          const decimals = mints.find((m) => m[0]?.equals(s.poolMint))?.[1]
            ?.decimals;
          if (typeof decimals !== "number") {
            throw new Error(
              `No decimals found for mint ${s.poolMint.toString()}`
            );
          }
          return {
            lp: s.poolMint.toString(),
            reserve0: s.token0.reserves.toString(),
            reserve1: s.token1.reserves.toString(),
            token0: s.token0.mint.toString(),
            token1: s.token1.mint.toString(),
            decimals,
          };
        })
        .sort((a, b) => (a.lp < b.lp ? -1 : 1)),
      null,
      2
    )
  );
  await fs.writeFile(
    "data/known-accounts.json",
    JSON.stringify(
      accounts.map((a) => ({ ...a, account: a.account.toString() })),
      null,
      2
    )
  );
  await fs.writeFile(
    "data/unknown-accounts.json",
    JSON.stringify(
      unknownAccounts.map((a) => ({
        ...a,
        account: a.account.toString(),
        mint: a.mint.toString(),
      })),
      null,
      2
    )
  );
  console.log(
    `Discovered and wrote ${accounts.length} known token reserves, ${unknownAccounts.length} unknown reserves.`
  );
};

fetchAllSwaps().catch((err) => {
  console.error(err);
});
