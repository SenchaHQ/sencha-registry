import { SignerWallet, SolanaProvider } from "@saberhq/solana-contrib";
import type { SwapInfoData } from "@senchahq/sencha-sdk";
import { SenchaSDK } from "@senchahq/sencha-sdk";
import { StaticTokenListResolutionStrategy } from "@solana/spl-token-registry";
import type { AccountInfo } from "@solana/web3.js";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import * as fs from "fs/promises";

const TOKEN_LIST = new StaticTokenListResolutionStrategy().resolve();

export const fetchAllSwaps = async (): Promise<void> => {
  const provider = SolanaProvider.load({
    connection: new Connection("https://sencha.rpcpool.com"),
    wallet: new SignerWallet(Keypair.generate()),
  });

  const sencha = SenchaSDK.load({ provider });
  const metas = await sencha.loadFactory().fetchAllSwapMetas();
  const swaps = await sencha.provider.connection.getMultipleAccountsInfo(
    metas.map((m) => m.swap)
  );

  const swapInfos = swaps
    .filter((s): s is AccountInfo<Buffer> => !!s)
    .map((s) =>
      sencha.programs.CpAmm.coder.accounts.decode<SwapInfoData>(
        "SwapInfo",
        s.data
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
        .map((s) => ({
          lp: s.poolMint.toString(),
          token0: s.token0.mint.toString(),
          token1: s.token1.mint.toString(),
        }))
        .sort((a, b) => (a.lp < b.lp ? -1 : 1)),
      null,
      2
    )
  );
  await fs.writeFile(
    "data/known-accounts.json",
    JSON.stringify(
      accounts,
      (_, v: unknown) => {
        if (v instanceof PublicKey) {
          return v.toString();
        }
        return v;
      },
      2
    )
  );
  await fs.writeFile(
    "data/unknown-accounts.json",
    JSON.stringify(
      unknownAccounts,
      (_, v: unknown) => {
        if (v instanceof PublicKey) {
          return v.toString();
        }
        return v;
      },
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
