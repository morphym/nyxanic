import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { OrganismToken } from "../target/types/organism_token";
import {
  PublicKey,
  Keypair,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountIdempotentInstruction,
  getAccount,
} from "@solana/spl-token";
import { expect } from "chai";
import BN from "bn.js";

function findPda(seed: string, programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(seed)],
    programId
  )[0];
}

async function withRetry<T>(label: string, fn: () => Promise<T>, attempts = 6): Promise<T> {
  let lastErr: any;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (e: any) {
      lastErr = e;
      const msg = String(e);
      if ((msg.includes("Blockhash not found") || msg.includes("block height exceeded")) && i < attempts) {
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

describe("organism token (body) — variable tests on devnet", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.organismToken as Program<OrganismToken>;
  const programId = program.programId;
  const wallet = provider.wallet as anchor.Wallet;

  // PDAs
  const mintPda = findPda("mint", programId);
  const mintAuthority = findPda("mint_authority", programId);
  const reserveVault = findPda("reserve_vault", programId);
  const feeCollector = findPda("fee_collector", programId);
  const bodyState = findPda("body_state", programId);
  const poolRegistry = findPda("pool_registry", programId);

  let userTokenAcct: PublicKey;

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  async function ensureUserAta(): Promise<PublicKey> {
    if (userTokenAcct) return userTokenAcct;
    userTokenAcct = await getAssociatedTokenAddress(
      mintPda,
      wallet.publicKey
    );
    const ix = createAssociatedTokenAccountIdempotentInstruction(
      wallet.publicKey,
      userTokenAcct,
      wallet.publicKey,
      mintPda
    );
    const tx = new anchor.web3.Transaction().add(ix);
    await withRetry("create ATA", () => provider.sendAndConfirm(tx, []));
    return userTokenAcct;
  }

  async function readUserBalance(): Promise<bigint> {
    if (!userTokenAcct) await ensureUserAta();
    const acct = await getAccount(provider.connection, userTokenAcct);
    return acct.amount;
  }

  async function readFeeBalance(): Promise<bigint> {
    const acct = await getAccount(provider.connection, feeCollector);
    return acct.amount;
  }

  function dir(opts: {
    mode?: number;
    fee?: number;
    spread?: number;
    throttle?: number;
    mintBurn?: number;
    collat?: number;
  }) {
    const modeMap = [
      { execute: {} },
      { throttle: {} },
      { route: {} },
      { halt: {} },
    ];
    return {
      executionMode: modeMap[opts.mode ?? 0] as any,
      feeAdjustment: new BN(opts.fee ?? 0),
      spreadAdjustment: new BN(opts.spread ?? 0),
      throttleFactor: opts.throttle ?? 10_000,
      mintBurnDelta: new BN(opts.mintBurn ?? 0),
      collateralRatioTarget: opts.collat ?? 0,
    };
  }

  async function setDirective(d: any, slot = 1) {
    await withRetry("setDirective", () =>
      program.methods
        .applyDirective(d, new BN(1_000_000), new BN(slot))
        .accounts({
          bodyState,
          authority: wallet.publicKey,
        })
        .rpc({ commitment: "confirmed" })
    );
  }

  async function mintN(n: number) {
    return withRetry("mint", () =>
      program.methods
        .mintTokens(new BN(n))
        .accounts({
          mint: mintPda,
          mintAuthority,
          bodyState,
          recipient: userTokenAcct,
          feeCollector,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc({ commitment: "confirmed" })
    );
  }

  // =========================================================================
  // Birth
  // =========================================================================

  it("initialize_mint (A1)", async () => {
    try {
      await program.methods
        .initializeMint()
        .accounts({
          mint: mintPda,
          mintAuthority,
          authority: wallet.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .rpc({ commitment: "confirmed" });
      console.log("    mint created:", mintPda.toBase58());
    } catch (e: any) {
      if (String(e).includes("already in use")) {
        console.log("    mint already exists (skip)");
      } else throw e;
    }
  });

  it("initialize_body (A2-A5)", async () => {
    try {
      await program.methods
        .initializeBody()
        .accounts({
          mint: mintPda,
          mintAuthority,
          reserveVault,
          feeCollector,
          bodyState,
          poolRegistry,
          authority: wallet.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .rpc({ commitment: "confirmed" });
      console.log("    body initialized");
    } catch (e: any) {
      if (String(e).includes("already in use")) {
        console.log("    body already initialized (skip)");
      } else throw e;
    }
    await ensureUserAta();
  });

  // =========================================================================
  // Variable: ℓ8 (Halt) — directive HALT must reject all ops
  // =========================================================================

  it("ℓ8 halt — mint should be rejected", async () => {
    await setDirective(dir({ mode: 3 }), 100); // Halt
    let rejected = false;
    try {
      await mintN(1_000_000);
    } catch (e: any) {
      rejected = String(e).includes("Halted") || String(e).includes("0x1770");
    }
    expect(rejected).to.equal(true);
    console.log("    ✓ mint rejected under Halt");
  });

  // =========================================================================
  // Variable: ℓ1 (Dynamic Fee) — fee_adjustment > 0 deducts fee
  // =========================================================================

  it("ℓ1 fee — 5% fee deducted on mint", async () => {
    await setDirective(dir({ mode: 0, fee: 50_000 }), 200); // 5% fee
    const userBefore = await readUserBalance();
    const feeBefore = await readFeeBalance();

    await mintN(1_000_000);

    const userAfter = await readUserBalance();
    const feeAfter = await readFeeBalance();

    const userDelta = userAfter - userBefore;
    const feeDelta = feeAfter - feeBefore;

    console.log(`    user got: ${userDelta}, fee collector got: ${feeDelta}`);
    expect(Number(userDelta)).to.equal(950_000); // 1M - 5%
    expect(Number(feeDelta)).to.equal(50_000);
  });

  it("ℓ1 fee — 0% fee (default) all goes to user", async () => {
    await setDirective(dir({ mode: 0, fee: 0 }), 201);
    const userBefore = await readUserBalance();
    const feeBefore = await readFeeBalance();

    await mintN(500_000);

    const userAfter = await readUserBalance();
    const feeAfter = await readFeeBalance();

    expect(Number(userAfter - userBefore)).to.equal(500_000);
    expect(Number(feeAfter - feeBefore)).to.equal(0);
    console.log(`    ✓ no fee deducted at fee=0`);
  });

  // =========================================================================
  // Variable: ℓ4 (Throttle) — throttle_factor caps throughput
  // =========================================================================

  it("ℓ4 throttle — exceeding capacity is rejected", async () => {
    // throttle_factor = 1 means capacity ≈ 100M * (1/10000) * 10^6 = 10M tokens
    await setDirective(dir({ mode: 1, throttle: 1 }), 300);

    // First mint within limit should succeed
    await mintN(1_000_000);

    // Now exceed: try to mint 100M (way above capacity)
    let rejected = false;
    try {
      await mintN(100_000_000_000);
    } catch (e: any) {
      rejected = String(e).includes("Throttled") || String(e).includes("0x1771");
    }
    expect(rejected).to.equal(true);
    console.log("    ✓ excess mint rejected under throttle");
  });

  // =========================================================================
  // Variable: ℓ2 (Spread) — spread_adjustment widens swap spread
  // =========================================================================

  it("ℓ2 spread — wider spread reduces tokens received from swap", async () => {
    // Need a collateral input account. Use the user's own organism tokens
    // as a stand-in collateral (any SPL works).
    // Reset to no spread, tight constraints
    await setDirective(dir({ mode: 2, spread: 100_000 }), 400); // 10% spread

    const userBefore = await readUserBalance();
    const feeBefore = await readFeeBalance();

    // Swap 1M tokens worth of "collateral" (using the same mint as collateral for test)
    await withRetry("swap", () =>
      program.methods
        .swapIn(new BN(1_000_000))
        .accounts({
          mint: mintPda,
          mintAuthority,
          bodyState,
          reserveVault,
          feeCollector,
          collateralIn: userTokenAcct,
          recipient: userTokenAcct,
          user: wallet.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc({ commitment: "confirmed" })
    );

    const userAfter = await readUserBalance();
    const feeAfter = await readFeeBalance();

    // User: -1M (collateral out) + 900_000 (after spread, no fee) = -100_000
    // Fee: +100_000 (the spread extracted)
    const userDelta = Number(userAfter - userBefore);
    const feeDelta = Number(feeAfter - feeBefore);

    console.log(`    user net delta: ${userDelta}, fee delta: ${feeDelta}`);
    expect(userDelta).to.equal(-100_000); // lost 10% to spread
    expect(feeDelta).to.equal(100_000);
  });

  // =========================================================================
  // Verify burn works under Execute mode
  // =========================================================================

  it("ℓ1 fee — burn deducts fee + burns net", async () => {
    await setDirective(dir({ mode: 0, fee: 30_000 }), 500); // 3% fee

    const userBefore = await readUserBalance();
    const feeBefore = await readFeeBalance();

    const burnAmount = 100_000;
    await withRetry("burn", () =>
      program.methods
        .burnTokens(new BN(burnAmount))
        .accounts({
          mint: mintPda,
          bodyState,
          holder: userTokenAcct,
          holderAuthority: wallet.publicKey,
          feeCollector,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc({ commitment: "confirmed" })
    );

    const userAfter = await readUserBalance();
    const feeAfter = await readFeeBalance();

    const userDelta = Number(userBefore - userAfter); // amount removed
    const feeDelta = Number(feeAfter - feeBefore);

    // user lost: full burnAmount (3% to fees, 97% destroyed)
    expect(userDelta).to.equal(burnAmount);
    expect(feeDelta).to.equal(3_000); // 3% of 100k
    console.log(`    ✓ user lost ${userDelta}, fee got ${feeDelta}`);
  });

  // =========================================================================
  // Final: reset to Execute
  // =========================================================================

  it("reset directive to Execute (no constraints)", async () => {
    await setDirective(dir({ mode: 0 }), 999);
    const body = await program.account.bodyState.fetch(bodyState);
    expect(body.currentDirective.executionMode).to.deep.equal({ execute: {} });
    console.log("    ✓ body returned to dormant Execute mode");
  });
});
