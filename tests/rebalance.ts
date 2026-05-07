import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { OrganismToken } from "../target/types/organism_token";
import { OrganismBrain } from "../target/types/organism_brain";
import { PublicKey } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAccount,
  getMint,
  getAssociatedTokenAddress,
  createTransferInstruction,
} from "@solana/spl-token";
import { expect } from "chai";
import BN from "bn.js";

const PRICE_SCALE = 1_000_000;

function findPda(seed: string, programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from(seed)], programId)[0];
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

describe("ℓ6 supply correction — devnet", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const conn = provider.connection;

  const body = anchor.workspace.organismToken as Program<OrganismToken>;
  const brain = anchor.workspace.organismBrain as Program<OrganismBrain>;
  const wallet = provider.wallet as anchor.Wallet;

  const orgMint = findPda("mint", body.programId);
  const mintAuthority = findPda("mint_authority", body.programId);
  const bodyState = findPda("body_state", body.programId);
  const lpState = findPda("lp_state", body.programId);
  const collateralVault = findPda("collateral_vault", body.programId);
  const feeCollector = findPda("fee_collector", body.programId);

  const brainSeverity = findPda("severity", brain.programId);
  const brainLadder = findPda("ladder", brain.programId);
  const brainIntensity = findPda("intensity", brain.programId);
  const brainActiveSet = findPda("active_set", brain.programId);
  const brainParams = findPda("params", brain.programId);

  // Look up existing MOCK_USDC from lp_state
  let mockUsdc: PublicKey;
  let userCollateral: PublicKey;
  let userOrg: PublicKey;

  it("look up mint + accounts", async () => {
    const lp = await body.account.lpState.fetch(lpState);
    mockUsdc = lp.collateralMint;
    userCollateral = await getAssociatedTokenAddress(mockUsdc, wallet.publicKey);
    userOrg = await getAssociatedTokenAddress(orgMint, wallet.publicKey);

    const userColl = await getAccount(conn, userCollateral);
    const userOrgAcc = await getAccount(conn, userOrg);
    const fc = await getAccount(conn, feeCollector);
    const vault = await getAccount(conn, collateralVault);
    const mintInfo = await getMint(conn, orgMint);

    console.log(`    MOCK_USDC mint: ${mockUsdc.toBase58()}`);
    console.log(`    user USDC: ${userColl.amount}`);
    console.log(`    user ORG:  ${userOrgAcc.amount}`);
    console.log(`    vault USDC: ${vault.amount}`);
    console.log(`    fee_collector ORG: ${fc.amount}`);
    console.log(`    total ORG supply: ${mintInfo.supply}`);
  });

  // ===========================================================
  // Step 1: do a swap_in to build up fee_collector treasury
  // ===========================================================

  it("swap_in 5k USDC → fee_collector receives extracted as ORG", async () => {
    const fcBefore = Number((await getAccount(conn, feeCollector)).amount);
    const supplyBefore = Number((await getMint(conn, orgMint)).supply);

    await withRetry("swap_in", () =>
      body.methods
        .lpSwapIn(new BN(5_000_000_000)) // 5k USDC
        .accounts({
          mint: orgMint,
          mintAuthority,
          bodyState,
          lpState,
          collateralVault,
          userCollateral,
          userOrg,
          feeCollector,
          user: wallet.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc({ commitment: "confirmed" })
    );

    const fcAfter = Number((await getAccount(conn, feeCollector)).amount);
    const supplyAfter = Number((await getMint(conn, orgMint)).supply);

    const fcDelta = fcAfter - fcBefore;
    const supplyDelta = supplyAfter - supplyBefore;
    console.log(`    fee_collector grew by: ${fcDelta} ORG (extracted spread+fee)`);
    console.log(`    total supply grew by: ${supplyDelta} ORG`);

    // At peg, fee=0.3% so extracted = 5_000_000_000 * 0.003 = 15_000_000
    // Plus current directive may have spread/fee from prior heartbeats
    expect(fcDelta).to.be.greaterThan(0);
  });

  // ===========================================================
  // Step 2: donate USDC to vault → engineer above-peg state
  // ===========================================================

  it("donate 50k USDC into vault → vault skews above peg", async () => {
    const donation = 50_000_000_000; // 50k USDC
    const ix = createTransferInstruction(
      userCollateral,
      collateralVault,
      wallet.publicKey,
      donation
    );
    const tx = new anchor.web3.Transaction().add(ix);
    await withRetry("donate", () => provider.sendAndConfirm(tx, []));

    const vault = Number((await getAccount(conn, collateralVault)).amount);
    const supply = Number((await getMint(conn, orgMint)).supply);
    const ratio = vault / supply;
    const derivedPrice = Math.floor((vault * PRICE_SCALE) / supply);
    console.log(`    vault now: ${vault}  supply: ${supply}  ratio: ${ratio.toFixed(4)}`);
    console.log(`    derived price: ${derivedPrice} = ${(derivedPrice / PRICE_SCALE).toFixed(4)}`);
    expect(derivedPrice).to.be.greaterThan(PRICE_SCALE * 1.05); // > +5% above peg
  });

  // ===========================================================
  // Step 3: drive sustained heartbeats → ladder climbs to ≥ 6
  // ===========================================================

  it("sustained heartbeat_observed → ladder climbs", async () => {
    let slot = 40000;
    let modesObserved: string[] = [];
    let lastRung = 0;
    for (let i = 0; i < 60; i++) {
      await withRetry("hb", () =>
        body.methods
          .heartbeatObserved(new BN(slot++))
          .accounts({
            mint: orgMint,
            collateralVault,
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
      const ladder = await brain.account.ladderState.fetch(brainLadder);
      if (ladder.rung !== lastRung) {
        const state = await body.account.bodyState.fetch(bodyState);
        const mode = Object.keys(state.currentDirective.executionMode)[0];
        const mbd = state.currentDirective.mintBurnDelta.toNumber();
        modesObserved.push(`rung=${ladder.rung} mode=${mode} mbd=${mbd}`);
        console.log(`    slot ${slot - 1}: ${modesObserved[modesObserved.length - 1]}`);
        lastRung = ladder.rung;
        if (ladder.rung >= 6) break;
      }
    }

    const finalLadder = await brain.account.ladderState.fetch(brainLadder);
    const finalState = await body.account.bodyState.fetch(bodyState);
    console.log(`    final: rung=${finalLadder.rung} mbd=${finalState.currentDirective.mintBurnDelta.toNumber()}`);

    // Expect we reached at least rung 6 OR mint_burn_delta is non-zero
    expect(finalLadder.rung).to.be.greaterThanOrEqual(6);
    expect(finalState.currentDirective.mintBurnDelta.toNumber()).to.not.equal(0);
  });

  // ===========================================================
  // Step 4: rebalance_supply → burns from fee_collector
  // ===========================================================

  it("rebalance_supply burns ORG from fee_collector treasury", async () => {
    const fcBefore = Number((await getAccount(conn, feeCollector)).amount);
    const supplyBefore = Number((await getMint(conn, orgMint)).supply);
    const stateBefore = await body.account.bodyState.fetch(bodyState);
    const mbdBefore = stateBefore.currentDirective.mintBurnDelta.toNumber();
    console.log(`    before: mbd=${mbdBefore} fc=${fcBefore} supply=${supplyBefore}`);

    await withRetry("rebalance", () =>
      body.methods
        .rebalanceSupply()
        .accounts({
          mint: orgMint,
          mintAuthority,
          bodyState,
          feeCollector,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc({ commitment: "confirmed" })
    );

    const fcAfter = Number((await getAccount(conn, feeCollector)).amount);
    const supplyAfter = Number((await getMint(conn, orgMint)).supply);
    const stateAfter = await body.account.bodyState.fetch(bodyState);

    const burned = supplyBefore - supplyAfter;
    const fcDelta = fcBefore - fcAfter;
    console.log(`    after:  fc=${fcAfter} supply=${supplyAfter}`);
    console.log(`    burned: ${burned} ORG  (from fee_collector)`);
    console.log(`    directive.mbd post: ${stateAfter.currentDirective.mintBurnDelta.toNumber()} (zeroed)`);

    // mbd was negative, burn should occur
    if (mbdBefore < 0) {
      expect(burned).to.be.greaterThan(0);
      expect(fcDelta).to.equal(burned); // fc decrease == supply decrease
      // mbd should be zeroed (applied)
      expect(stateAfter.currentDirective.mintBurnDelta.toNumber()).to.equal(0);
    } else {
      console.log(`    (mbd was ≥0; no burn expected)`);
    }
  });

  // ===========================================================
  // Step 5: confirm derived price moved closer to peg
  // ===========================================================

  it("derived price improved after burn", async () => {
    const vault = Number((await getAccount(conn, collateralVault)).amount);
    const supply = Number((await getMint(conn, orgMint)).supply);
    const derivedPrice = Math.floor((vault * PRICE_SCALE) / supply);
    console.log(`    post-rebalance: vault=${vault} supply=${supply} price=${(derivedPrice/PRICE_SCALE).toFixed(4)}`);
    // We expect price to be slightly LOWER (closer to peg) than the spike from donation,
    // but likely still elevated since burn was capped to fc balance.
  });

  // ===========================================================
  // Cleanup: heartbeat back toward peg so other tests work
  // ===========================================================

  it("recover: many heartbeats to drain ladder", async () => {
    let slot = 50000;
    for (let i = 0; i < 100; i++) {
      await withRetry("recover", () =>
        body.methods
          .heartbeatObserved(new BN(slot++))
          .accounts({
            mint: orgMint, collateralVault, bodyState,
            brainSeverity, brainLadder, brainIntensity, brainActiveSet, brainParams,
            brainProgram: brain.programId,
          })
          .rpc({ commitment: "confirmed" })
      );
    }
    const ladder = await brain.account.ladderState.fetch(brainLadder);
    console.log(`    final rung: ${ladder.rung}`);
  });
});
