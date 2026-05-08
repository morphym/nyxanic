import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { OrganismToken } from "../target/types/organism_token";
import { OrganismBrain } from "../target/types/organism_brain";
import { NyxanicTestToken } from "../target/types/nyxanic_test_token";
import { PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAccount,
  getMint,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import { expect } from "chai";
import BN from "bn.js";

const PRICE_SCALE = 1_000_000;
const UNIT = 1_000_000;

function findPda(seed: string, programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from(seed)], programId)[0];
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
      if (msg.includes("already in use") && i === 1) {
        return null as any;
      }
      lastErr = e;
      throw e;
    }
  }
  throw lastErr;
}

describe("full birth — NTT collateral + organism on fresh devnet PDAs", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const conn = provider.connection;
  const wallet = provider.wallet as anchor.Wallet;

  const ntt = anchor.workspace.nyxanicTestToken as Program<NyxanicTestToken>;
  const brain = anchor.workspace.organismBrain as Program<OrganismBrain>;
  const body = anchor.workspace.organismToken as Program<OrganismToken>;

  // NTT (test currency) PDAs
  const nttMint = findPda("ntt_mint", ntt.programId);
  const nttAuthority = findPda("ntt_mint_authority", ntt.programId);

  // Brain PDAs
  const brainSeverity = findPda("severity", brain.programId);
  const brainLadder = findPda("ladder", brain.programId);
  const brainIntensity = findPda("intensity", brain.programId);
  const brainActiveSet = findPda("active_set", brain.programId);
  const brainParams = findPda("params", brain.programId);

  // Body PDAs
  const orgMint = findPda("mint", body.programId);
  const mintAuthority = findPda("mint_authority", body.programId);
  const reserveVault = findPda("reserve_vault", body.programId);
  const feeCollector = findPda("fee_collector", body.programId);
  const bodyState = findPda("body_state", body.programId);
  const poolRegistry = findPda("pool_registry", body.programId);
  const lpState = findPda("lp_state", body.programId);
  const collateralVault = findPda("collateral_vault", body.programId);

  let userNtt: PublicKey;
  let userOrg: PublicKey;

  // ===========================================================================
  // PHASE 1 — Initialize the test currency (NTT)
  // ===========================================================================

  it("birth: initialize NTT (test currency mint)", async () => {
    try {
      await withRetry("init_ntt", () =>
        ntt.methods
          .initialize()
          .accounts({
            mintAuthority: nttAuthority,
            mint: nttMint,
            payer: wallet.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
            rent: SYSVAR_RENT_PUBKEY,
          })
          .rpc({ commitment: "confirmed" })
      );
      console.log(`    NTT mint: ${nttMint.toBase58()}`);
    } catch (e: any) {
      if (String(e).includes("already in use")) {
        console.log(`    NTT already initialized: ${nttMint.toBase58()}`);
      } else throw e;
    }
  });

  it("create user NTT ATA + airdrop 1M NTT", async () => {
    userNtt = await getAssociatedTokenAddress(nttMint, wallet.publicKey);
    const ix = createAssociatedTokenAccountIdempotentInstruction(
      wallet.publicKey, userNtt, wallet.publicKey, nttMint
    );
    const tx = new anchor.web3.Transaction().add(ix);
    await withRetry("user NTT ATA", () => provider.sendAndConfirm(tx, []));

    await withRetry("airdrop", () =>
      ntt.methods
        .airdrop(new BN(1_000_000_000_000)) // 1M with 6 decimals
        .accounts({
          mint: nttMint,
          mintAuthority: nttAuthority,
          recipient: userNtt,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc({ commitment: "confirmed" })
    );

    const bal = await getAccount(conn, userNtt);
    console.log(`    user NTT: ${bal.amount}`);
    expect(Number(bal.amount)).to.be.greaterThanOrEqual(1_000_000_000_000);
  });

  // ===========================================================================
  // PHASE 2 — Birth the brain (B5, B1-B3, active_set)
  // ===========================================================================

  it("birth: initialize brain params (B5)", async () => {
    try {
      await withRetry("init_params", () =>
        brain.methods
          .initializeParams(
            new BN(5_000), 3, new BN(50_000), new BN(3_000),
            new BN(10), new BN(30), new BN(20),
            new BN(100_000), new BN(50_000), new BN(100_000),
            [
              new BN(50_000), new BN(100_000), new BN(200_000), new BN(300_000),
              new BN(450_000), new BN(600_000), new BN(750_000), new BN(900_000),
            ],
            new BN(200_000), new BN(600_000)
          )
          .accounts({ params: brainParams })
          .rpc({ commitment: "confirmed" })
      );
      console.log("    params initialized");
    } catch (e: any) {
      if (String(e).includes("already in use")) {
        console.log("    params already exist");
      } else throw e;
    }
  });

  it("birth: initialize brain state (B1-B3)", async () => {
    try {
      await withRetry("init_brain", () =>
        brain.methods
          .initializeBrain()
          .accounts({
            severity: brainSeverity,
            ladder: brainLadder,
            intensity: brainIntensity,
          })
          .rpc({ commitment: "confirmed" })
      );
      console.log("    brain initialized");
    } catch (e: any) {
      if (String(e).includes("already in use")) {
        console.log("    brain already initialized");
      } else throw e;
    }
  });

  it("birth: initialize active_set", async () => {
    try {
      await withRetry("init_as", () =>
        brain.methods
          .initializeActiveSet()
          .accounts({ activeSet: brainActiveSet })
          .rpc({ commitment: "confirmed" })
      );
      console.log("    active_set initialized");
    } catch (e: any) {
      if (String(e).includes("already in use")) {
        console.log("    active_set already exists");
      } else throw e;
    }
  });

  // ===========================================================================
  // PHASE 3 — Birth the body (mint, vault, state, registry)
  // ===========================================================================

  it("birth: initialize ORG mint (A1)", async () => {
    try {
      await withRetry("init_mint", () =>
        body.methods
          .initializeMint()
          .accounts({
            mint: orgMint,
            mintAuthority,
            authority: wallet.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
            rent: SYSVAR_RENT_PUBKEY,
          })
          .rpc({ commitment: "confirmed" })
      );
      console.log(`    ORG mint: ${orgMint.toBase58()}`);
    } catch (e: any) {
      if (String(e).includes("already in use")) {
        console.log(`    ORG mint already exists: ${orgMint.toBase58()}`);
      } else throw e;
    }
  });

  it("birth: initialize body (A2-A5)", async () => {
    try {
      await withRetry("init_body", () =>
        body.methods
          .initializeBody()
          .accounts({
            mint: orgMint,
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
          .rpc({ commitment: "confirmed" })
      );
      console.log("    body initialized");
    } catch (e: any) {
      if (String(e).includes("already in use")) {
        console.log("    body already initialized");
      } else throw e;
    }
  });

  // ===========================================================================
  // PHASE 4 — Initialize LP using NTT as collateral
  // ===========================================================================

  it("birth: initialize LP with NTT as collateral mint", async () => {
    try {
      await withRetry("init_lp", () =>
        body.methods
          .initializeLp()
          .accounts({
            collateralMint: nttMint,
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
      console.log(`    collateral_vault: ${collateralVault.toBase58()}`);
    } catch (e: any) {
      if (String(e).includes("already in use")) {
        const lp = await body.account.lpState.fetch(lpState);
        if (lp.collateralMint.toBase58() !== nttMint.toBase58()) {
          throw new Error(`LP already initialized with different mint: ${lp.collateralMint.toBase58()}`);
        }
        console.log("    LP already initialized with NTT");
      } else throw e;
    }
    const lp = await body.account.lpState.fetch(lpState);
    expect(lp.collateralMint.toBase58()).to.equal(nttMint.toBase58());
  });

  // ===========================================================================
  // PHASE 5 — First breath (seed liquidity)
  // ===========================================================================

  it("first breath: seed 100k NTT, get matching ORG", async () => {
    userOrg = await getAssociatedTokenAddress(orgMint, wallet.publicKey);
    const ix = createAssociatedTokenAccountIdempotentInstruction(
      wallet.publicKey, userOrg, wallet.publicKey, orgMint
    );
    const tx = new anchor.web3.Transaction().add(ix);
    await withRetry("user ORG ATA", () => provider.sendAndConfirm(tx, []));

    const lp = await body.account.lpState.fetch(lpState);
    if (lp.seeded) {
      console.log("    already seeded");
      return;
    }

    const seed = new BN(100_000_000_000); // 100k NTT
    await withRetry("first_breath", () =>
      body.methods
        .firstBreath(seed)
        .accounts({
          mint: orgMint,
          mintAuthority,
          lpState,
          collateralVault,
          userCollateral: userNtt,
          userOrg,
          user: wallet.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc({ commitment: "confirmed" })
    );

    const vault = await getAccount(conn, collateralVault);
    const userOrgBal = await getAccount(conn, userOrg);
    console.log(`    vault NTT: ${vault.amount}  user ORG: ${userOrgBal.amount}`);
    expect(Number(vault.amount)).to.equal(100_000_000_000);
  });

  // ===========================================================================
  // PHASE 6 — Heartbeat + swap roundtrip
  // ===========================================================================

  it("heartbeat at peg + swap roundtrip", async () => {
    // Heartbeat first to establish a directive
    await withRetry("hb", () =>
      body.methods
        .heartbeatObserved(new BN(70000))
        .accounts({
          mint: orgMint,
          collateralVault,
          bodyState,
          brainSeverity, brainLadder, brainIntensity, brainActiveSet, brainParams,
          brainProgram: brain.programId,
        })
        .rpc({ commitment: "confirmed" })
    );

    const stateBefore = await body.account.bodyState.fetch(bodyState);
    console.log(`    directive: fee=${stateBefore.currentDirective.feeAdjustment.toNumber()} mode=${JSON.stringify(stateBefore.currentDirective.executionMode)}`);

    // swap_in 1k NTT → ~997 ORG (0.3% fee at peg)
    const userOrgBefore = Number((await getAccount(conn, userOrg)).amount);
    const userNttBefore = Number((await getAccount(conn, userNtt)).amount);

    await withRetry("swap_in", () =>
      body.methods
        .lpSwapIn(new BN(1_000_000_000))
        .accounts({
          mint: orgMint, mintAuthority, bodyState, lpState, collateralVault,
          userCollateral: userNtt, userOrg, feeCollector,
          user: wallet.publicKey, tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc({ commitment: "confirmed" })
    );

    const userOrgAfter = Number((await getAccount(conn, userOrg)).amount);
    const userNttAfter = Number((await getAccount(conn, userNtt)).amount);

    const orgGained = userOrgAfter - userOrgBefore;
    const nttSpent = userNttBefore - userNttAfter;
    console.log(`    swap_in: spent ${nttSpent} NTT, got ${orgGained} ORG`);
    expect(nttSpent).to.equal(1_000_000_000);
    expect(orgGained).to.equal(997_000_000); // 1B * 0.997

    // swap_out 500 ORG → ~498.5 NTT
    await withRetry("swap_out", () =>
      body.methods
        .lpSwapOut(new BN(500_000_000))
        .accounts({
          mint: orgMint, mintAuthority, bodyState, lpState, collateralVault,
          userCollateral: userNtt, userOrg,
          user: wallet.publicKey, tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc({ commitment: "confirmed" })
    );

    const userOrgFinal = Number((await getAccount(conn, userOrg)).amount);
    const userNttFinal = Number((await getAccount(conn, userNtt)).amount);
    const orgSpent = userOrgAfter - userOrgFinal;
    const nttGained = userNttFinal - userNttAfter;
    console.log(`    swap_out: spent ${orgSpent} ORG, got ${nttGained} NTT`);
    expect(orgSpent).to.equal(500_000_000);
    expect(nttGained).to.equal(498_500_000); // 500M * 0.997
  });

  // ===========================================================================
  // Summary: addresses
  // ===========================================================================

  it("summary", async () => {
    console.log("\n    === Deployed addresses (devnet) ===");
    console.log(`    NTT program:      ${ntt.programId.toBase58()}`);
    console.log(`    NTT mint (PDA):   ${nttMint.toBase58()}`);
    console.log(`    Brain program:    ${brain.programId.toBase58()}`);
    console.log(`    Body program:     ${body.programId.toBase58()}`);
    console.log(`    ORG mint (PDA):   ${orgMint.toBase58()}`);
    console.log(`    Body state:       ${bodyState.toBase58()}`);
    console.log(`    LP state:         ${lpState.toBase58()}`);
    console.log(`    Collateral vault: ${collateralVault.toBase58()}`);
  });
});
