import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { OrganismToken } from "../target/types/organism_token";
import { OrganismBrain } from "../target/types/organism_brain";
import { PublicKey, Keypair, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAccount,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import { expect } from "chai";
import BN from "bn.js";

const PRICE_SCALE = 1_000_000;
const COLLATERAL_DECIMALS = 6;
const ORG_DECIMALS = 6;

function findPda(seed: string, programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(seed)],
    programId
  )[0];
}

function price(d: number): BN {
  return new BN(Math.round(d * PRICE_SCALE));
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

describe("internal LP — devnet bidirectional swap", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const body = anchor.workspace.organismToken as Program<OrganismToken>;
  const brain = anchor.workspace.organismBrain as Program<OrganismBrain>;
  const wallet = provider.wallet as anchor.Wallet;
  const conn = provider.connection;

  // ORG-side PDAs
  const orgMint = findPda("mint", body.programId);
  const mintAuthority = findPda("mint_authority", body.programId);
  const bodyState = findPda("body_state", body.programId);
  const lpState = findPda("lp_state", body.programId);
  const collateralVault = findPda("collateral_vault", body.programId);

  // Brain PDAs (for heartbeat)
  const brainSeverity = findPda("severity", brain.programId);
  const brainLadder = findPda("ladder", brain.programId);
  const brainIntensity = findPda("intensity", brain.programId);
  const brainActiveSet = findPda("active_set", brain.programId);
  const brainParams = findPda("params", brain.programId);

  let mockUsdc: PublicKey;
  let userCollateral: PublicKey;
  let userOrg: PublicKey;

  // ===========================================================
  // Setup: mint a mock collateral token, fund the user
  // ===========================================================

  it("create MOCK_USDC SPL mint + user accounts", async () => {
    // Create the collateral mint with the wallet as authority (devnet only)
    mockUsdc = await withRetry("create mint", () =>
      createMint(conn, wallet.payer, wallet.publicKey, null, COLLATERAL_DECIMALS)
    );
    console.log(`    MOCK_USDC mint: ${mockUsdc.toBase58()}`);

    // User's collateral ATA
    const userCollAcct = await withRetry("user collateral ATA", () =>
      getOrCreateAssociatedTokenAccount(conn, wallet.payer, mockUsdc, wallet.publicKey)
    );
    userCollateral = userCollAcct.address;
    // Mint 1,000,000 MOCK_USDC (with 6 decimals = 1e12 base units)
    await withRetry("mint USDC", () =>
      mintTo(conn, wallet.payer, mockUsdc, userCollateral, wallet.publicKey, 1_000_000_000_000)
    );
    const collBal = await getAccount(conn, userCollateral);
    console.log(`    user MOCK_USDC: ${collBal.amount}`);

    // User's ORG ATA
    userOrg = await getAssociatedTokenAddress(orgMint, wallet.publicKey);
    const ix = createAssociatedTokenAccountIdempotentInstruction(
      wallet.publicKey, userOrg, wallet.publicKey, orgMint
    );
    const tx = new anchor.web3.Transaction().add(ix);
    await withRetry("user ORG ATA", () => provider.sendAndConfirm(tx, []));
    console.log(`    user ORG ATA: ${userOrg.toBase58()}`);
  });

  // ===========================================================
  // Birth step 10: initialize_lp + first_breath
  // ===========================================================

  it("initialize_lp", async () => {
    try {
      await withRetry("init_lp", () =>
        body.methods
          .initializeLp()
          .accounts({
            collateralMint: mockUsdc,
            mintAuthority,
            collateralVault,
            lpState,
            payer: wallet.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
            rent: SYSVAR_RENT_PUBKEY,
          })
          .rpc({ commitment: "confirmed" })
      );
      console.log(`    lp_state: ${lpState.toBase58()}`);
      console.log(`    collateral_vault: ${collateralVault.toBase58()}`);
    } catch (e: any) {
      if (String(e).includes("already in use")) {
        console.log("    LP already initialized — verifying mint matches");
        const lp = await body.account.lpState.fetch(lpState);
        if (lp.collateralMint.toBase58() !== mockUsdc.toBase58()) {
          throw new Error(
            `LP previously initialized with different collateral mint: ${lp.collateralMint.toBase58()}`
          );
        }
      } else throw e;
    }
  });

  it("first_breath: seed 100,000 MOCK_USDC, mint matching ORG", async () => {
    const lp = await body.account.lpState.fetch(lpState);
    if (lp.seeded) {
      console.log("    already seeded — skip");
      return;
    }
    const seed = new BN(100_000_000_000); // 100k with 6 decimals
    await withRetry("first_breath", () =>
      body.methods
        .firstBreath(seed)
        .accounts({
          mint: orgMint,
          mintAuthority,
          lpState,
          collateralVault,
          userCollateral,
          userOrg,
          user: wallet.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc({ commitment: "confirmed" })
    );

    const vault = await getAccount(conn, collateralVault);
    const userOrgBal = await getAccount(conn, userOrg);
    console.log(`    vault collateral: ${vault.amount}  user ORG: ${userOrgBal.amount}`);
    expect(Number(vault.amount)).to.equal(100_000_000_000);
    expect(Number(userOrgBal.amount)).to.equal(100_000_000_000);
  });

  // ===========================================================
  // Drive a directive into the body via brain heartbeat at peg
  // (mode=Execute, fee=base 3000=0.3%, no spread)
  // ===========================================================

  it("heartbeat at peg → minimal fee, no spread", async () => {
    await withRetry("hb peg", () =>
      body.methods
        .heartbeat(price(1.0), 0, new BN(20000))
        .accounts({
          bodyState,
          brainSeverity,
          brainLadder,
          brainIntensity,
          brainActiveSet,
          brainParams,
          brainProgram: brain.programId,
        })
        .rpc({ commitment: "confirmed" })
    );
    const state = await body.account.bodyState.fetch(bodyState);
    console.log(`    fee=${state.currentDirective.feeAdjustment.toNumber()} spread=${state.currentDirective.spreadAdjustment.toNumber()}`);
  });

  // ===========================================================
  // Trade roundtrip at peg
  // ===========================================================

  it("swap_in: 10,000 USDC → ~10,000 ORG (minus fee)", async () => {
    const before = {
      coll: Number((await getAccount(conn, userCollateral)).amount),
      org: Number((await getAccount(conn, userOrg)).amount),
      vault: Number((await getAccount(conn, collateralVault)).amount),
    };

    const amt = new BN(10_000_000_000); // 10k
    await withRetry("swap_in", () =>
      body.methods
        .lpSwapIn(amt)
        .accounts({
          mint: orgMint,
          mintAuthority,
          bodyState,
          lpState,
          collateralVault,
          userCollateral,
          userOrg,
          user: wallet.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc({ commitment: "confirmed" })
    );

    const after = {
      coll: Number((await getAccount(conn, userCollateral)).amount),
      org: Number((await getAccount(conn, userOrg)).amount),
      vault: Number((await getAccount(conn, collateralVault)).amount),
    };

    const usdcSpent = before.coll - after.coll;
    const orgGained = after.org - before.org;
    const vaultGained = after.vault - before.vault;

    console.log(`    USDC spent: ${usdcSpent}  ORG gained: ${orgGained}  vault gained: ${vaultGained}`);
    expect(usdcSpent).to.equal(10_000_000_000);
    expect(vaultGained).to.equal(10_000_000_000);
    // ORG gained = 10000 - fee. Fee = 3000/1e6 * 10000 = 30 (in ORG units = 30_000_000)
    expect(orgGained).to.equal(10_000_000_000 - 30_000_000); // 9.97k ORG
  });

  it("swap_out: 5,000 ORG → ~5,000 USDC (minus fee)", async () => {
    const before = {
      coll: Number((await getAccount(conn, userCollateral)).amount),
      org: Number((await getAccount(conn, userOrg)).amount),
      vault: Number((await getAccount(conn, collateralVault)).amount),
    };

    const amt = new BN(5_000_000_000); // 5k
    await withRetry("swap_out", () =>
      body.methods
        .lpSwapOut(amt)
        .accounts({
          mint: orgMint,
          mintAuthority,
          bodyState,
          lpState,
          collateralVault,
          userCollateral,
          userOrg,
          user: wallet.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc({ commitment: "confirmed" })
    );

    const after = {
      coll: Number((await getAccount(conn, userCollateral)).amount),
      org: Number((await getAccount(conn, userOrg)).amount),
      vault: Number((await getAccount(conn, collateralVault)).amount),
    };

    const orgSpent = before.org - after.org;
    const usdcGained = after.coll - before.coll;
    const vaultRetained = before.vault - after.vault;

    console.log(`    ORG spent: ${orgSpent}  USDC gained: ${usdcGained}  vault sent: ${vaultRetained}`);
    expect(orgSpent).to.equal(5_000_000_000);
    // Get back 5k - fee (15 USDC)
    expect(usdcGained).to.equal(5_000_000_000 - 15_000_000);
    // Vault sends only what user gets; rest stays as over-collateralization
    expect(vaultRetained).to.equal(5_000_000_000 - 15_000_000);
  });

  // ===========================================================
  // Trade under stress: drive severity up so fee + spread kick in
  // ===========================================================

  it("drive into stress, observe directive change, swap", async () => {
    // Heartbeat at 0.99 (severity ~0.89, high band) for ~30 ticks to climb ladder
    // and accumulate spread/fee. Single tick won't get much spread since
    // spread is r ≥ 2 (rung ≥ 2).
    let slot = 21000;
    for (let i = 0; i < 25; i++) {
      await withRetry("hb stress", () =>
        body.methods
          .heartbeat(price(0.99), 1, new BN(slot++))
          .accounts({
            bodyState, brainSeverity, brainLadder, brainIntensity,
            brainActiveSet, brainParams, brainProgram: brain.programId,
          })
          .rpc({ commitment: "confirmed" })
      );
    }
    const state = await body.account.bodyState.fetch(bodyState);
    const fee = state.currentDirective.feeAdjustment.toNumber();
    const spread = state.currentDirective.spreadAdjustment.toNumber();
    const mode = Object.keys(state.currentDirective.executionMode)[0];
    console.log(`    after stress: mode=${mode} fee=${fee} spread=${spread}`);

    // Run a swap_in with stress directive in place
    const before = {
      coll: Number((await getAccount(conn, userCollateral)).amount),
      org: Number((await getAccount(conn, userOrg)).amount),
    };
    try {
      await withRetry("stressed swap_in", () =>
        body.methods
          .lpSwapIn(new BN(1_000_000_000)) // 1k
          .accounts({
            mint: orgMint, mintAuthority, bodyState, lpState, collateralVault,
            userCollateral, userOrg, user: wallet.publicKey, tokenProgram: TOKEN_PROGRAM_ID,
          })
          .rpc({ commitment: "confirmed" })
      );
      const after = {
        coll: Number((await getAccount(conn, userCollateral)).amount),
        org: Number((await getAccount(conn, userOrg)).amount),
      };
      const usdcSpent = before.coll - after.coll;
      const orgGained = after.org - before.org;
      const extracted = usdcSpent - orgGained;
      const extractedPct = (extracted / usdcSpent) * 100;
      console.log(`    spent: ${usdcSpent}  got: ${orgGained}  extracted: ${extracted} (${extractedPct.toFixed(3)}%)`);

      // Under stress, extracted % should be larger than at peg (was 0.3%)
      expect(extracted).to.be.greaterThan(3_000_000); // > 0.3%
    } catch (e: any) {
      // If brain escalated to Halt, swap should be rejected — that's also valid behavior
      if (String(e).includes("Halted")) {
        console.log("    brain escalated to Halt — swap correctly rejected");
      } else if (String(e).includes("Throttled")) {
        console.log("    brain escalated to Throttle — swap correctly capped");
      } else {
        throw e;
      }
    }
  });

  // ===========================================================
  // Recovery
  // ===========================================================

  it("recover: heartbeat back to peg", async () => {
    let slot = 22000;
    for (let i = 0; i < 50; i++) {
      await withRetry("hb recover", () =>
        body.methods
          .heartbeat(price(1.0), -1, new BN(slot++))
          .accounts({
            bodyState, brainSeverity, brainLadder, brainIntensity,
            brainActiveSet, brainParams, brainProgram: brain.programId,
          })
          .rpc({ commitment: "confirmed" })
      );
    }
    const state = await body.account.bodyState.fetch(bodyState);
    const sev = await brain.account.severityState.fetch(brainSeverity);
    console.log(`    final mode=${JSON.stringify(state.currentDirective.executionMode)} severity=${sev.s.toNumber()}`);
    expect(sev.s.toNumber()).to.equal(0);
  });
});
