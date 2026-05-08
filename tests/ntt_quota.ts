import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { NyxanicTestToken } from "../target/types/nyxanic_test_token";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAccount,
  getMint,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import { expect } from "chai";
import BN from "bn.js";

function findPda(seeds: (Buffer | Uint8Array)[], programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(seeds, programId)[0];
}

async function withRetry<T>(label: string, fn: () => Promise<T>, attempts = 6): Promise<T> {
  let lastErr: any;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (e: any) {
      const msg = String(e);
      if ((msg.includes("Blockhash not found") || msg.includes("block height exceeded")) && i < attempts) {
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }
      lastErr = e;
      throw e;
    }
  }
  throw lastErr;
}

const AIRDROP_MAX_PER_CALL = 50_000_000_000;
const LIQUIDITY_QUOTA = 900_000_000_000_000;
const AIRDROP_QUOTA = 100_000_000_000_000;

describe("NTT — supply cap + airdrop limits + cooldown", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const conn = provider.connection;
  const wallet = provider.wallet as anchor.Wallet;

  const ntt = anchor.workspace.nyxanicTestToken as Program<NyxanicTestToken>;

  const mint = findPda([Buffer.from("ntt_mint")], ntt.programId);
  const mintAuthority = findPda([Buffer.from("ntt_mint_authority")], ntt.programId);
  const config = findPda([Buffer.from("ntt_config")], ntt.programId);
  const myAirdropRecord = findPda(
    [Buffer.from("ntt_airdrop"), wallet.publicKey.toBuffer()],
    ntt.programId
  );

  let myAta: PublicKey;

  it("ensure config PDA exists (one-shot migration if needed)", async () => {
    try {
      await withRetry("init_config", () =>
        ntt.methods
          .initializeConfigOnly()
          .accounts({
            config,
            payer: wallet.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .rpc({ commitment: "confirmed" })
      );
      console.log(`    config initialized (migration): ${config.toBase58()}`);
    } catch (e: any) {
      if (String(e).includes("already in use")) {
        console.log(`    config already exists: ${config.toBase58()}`);
      } else throw e;
    }

    const cfg = await ntt.account.tokenConfig.fetch(config);
    console.log(`    liquidity_minted=${cfg.liquidityMinted.toString()} airdropped=${cfg.airdropped.toString()}`);
  });

  it("create user ATA", async () => {
    myAta = await getAssociatedTokenAddress(mint, wallet.publicKey);
    const ix = createAssociatedTokenAccountIdempotentInstruction(
      wallet.publicKey, myAta, wallet.publicKey, mint
    );
    const tx = new anchor.web3.Transaction().add(ix);
    await withRetry("ata", () => provider.sendAndConfirm(tx, []));
  });

  // -----------------------------------------------------------------------
  // Airdrop max per call enforcement
  // -----------------------------------------------------------------------

  it("rejects airdrop > 50k per call", async () => {
    let rejected = false;
    let errStr = "";
    try {
      await ntt.methods
        .airdrop(new BN(AIRDROP_MAX_PER_CALL + 1))
        .accounts({
          mint,
          mintAuthority,
          config,
          recipient: myAta,
          recipientWallet: wallet.publicKey,
          airdropRecord: myAirdropRecord,
          payer: wallet.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc({ commitment: "confirmed" });
    } catch (e: any) {
      errStr = String(e);
      rejected = errStr.includes("InvalidAmount");
    }
    if (!rejected) console.log(`    ! got: ${errStr.substring(0, 400)}`);
    expect(rejected).to.equal(true);
    console.log(`    ✓ rejected airdrop > 50k`);
  });

  // -----------------------------------------------------------------------
  // First airdrop succeeds
  // -----------------------------------------------------------------------

  it("first airdrop of 50k succeeds, sets cooldown", async () => {
    // Check if airdrop_record already exists (from prior run within 8h)
    let recordExists = false;
    try {
      const rec = await ntt.account.airdropRecord.fetch(myAirdropRecord);
      const now = Math.floor(Date.now() / 1000);
      const elapsed = now - rec.lastAirdropUnix.toNumber();
      console.log(`    record exists: last_airdrop=${rec.lastAirdropUnix.toNumber()} elapsed=${elapsed}s wallet_total=${rec.totalAirdroppedToWallet.toString()}`);
      recordExists = true;
      if (elapsed < 8 * 3600) {
        console.log(`    SKIP: cooldown still active (${(8*3600 - elapsed)/3600 |0}h remaining)`);
        return;
      }
    } catch {
      console.log("    no prior record — first airdrop");
    }

    const balBefore = Number((await getAccount(conn, myAta)).amount);

    await withRetry("airdrop", () =>
      ntt.methods
        .airdrop(new BN(AIRDROP_MAX_PER_CALL))
        .accounts({
          mint,
          mintAuthority,
          config,
          recipient: myAta,
          recipientWallet: wallet.publicKey,
          airdropRecord: myAirdropRecord,
          payer: wallet.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc({ commitment: "confirmed" })
    );

    const balAfter = Number((await getAccount(conn, myAta)).amount);
    const rec = await ntt.account.airdropRecord.fetch(myAirdropRecord);
    const cfg = await ntt.account.tokenConfig.fetch(config);

    console.log(`    minted: ${balAfter - balBefore} NTT`);
    console.log(`    record.last_airdrop_unix: ${rec.lastAirdropUnix.toString()}`);
    console.log(`    config.airdropped (global): ${cfg.airdropped.toString()}`);
    expect(balAfter - balBefore).to.equal(AIRDROP_MAX_PER_CALL);
  });

  // -----------------------------------------------------------------------
  // Second airdrop within cooldown is rejected
  // -----------------------------------------------------------------------

  it("second airdrop within 8h is rejected (cooldown)", async () => {
    let rejected = false;
    let errStr = "";
    try {
      await ntt.methods
        .airdrop(new BN(1_000_000_000)) // 1k
        .accounts({
          mint,
          mintAuthority,
          config,
          recipient: myAta,
          recipientWallet: wallet.publicKey,
          airdropRecord: myAirdropRecord,
          payer: wallet.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc({ commitment: "confirmed" });
    } catch (e: any) {
      errStr = String(e);
      rejected = errStr.includes("AirdropOnCooldown");
    }
    expect(rejected).to.equal(true);
    console.log(`    ✓ second airdrop rejected (cooldown)`);
  });

  // -----------------------------------------------------------------------
  // seed_liquidity quota — first call works, then exceeding fails
  // -----------------------------------------------------------------------

  it("seed_liquidity respects 90% cap", async () => {
    const cfg = await ntt.account.tokenConfig.fetch(config);
    console.log(`    current liquidity_minted: ${cfg.liquidityMinted.toString()}`);

    // Try to seed amount that would exceed quota
    const remaining = LIQUIDITY_QUOTA - cfg.liquidityMinted.toNumber();
    if (remaining <= 0) {
      console.log("    quota already exhausted");
      return;
    }

    let rejected = false;
    let errStr = "";
    try {
      // Try to mint more than remaining quota
      await ntt.methods
        .seedLiquidity(new BN(LIQUIDITY_QUOTA + 1))
        .accounts({
          mint,
          mintAuthority,
          config,
          recipient: myAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc({ commitment: "confirmed" });
    } catch (e: any) {
      errStr = String(e);
      rejected = errStr.includes("LiquidityQuotaExhausted");
    }
    if (!rejected) console.log(`    ! got: ${errStr.substring(0, 400)}`);
    expect(rejected).to.equal(true);
    console.log(`    ✓ over-quota seed_liquidity rejected`);
  });

  it("show config snapshot", async () => {
    const cfg = await ntt.account.tokenConfig.fetch(config);
    const m = await getMint(conn, mint);
    console.log(`\n    --- NTT state ---`);
    console.log(`    total supply (mint):  ${m.supply}`);
    console.log(`    liquidity_minted:     ${cfg.liquidityMinted.toString()} / ${LIQUIDITY_QUOTA}`);
    console.log(`    airdropped (global):  ${cfg.airdropped.toString()} / ${AIRDROP_QUOTA}`);
  });
});
