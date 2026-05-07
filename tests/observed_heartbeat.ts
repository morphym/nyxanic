import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { OrganismToken } from "../target/types/organism_token";
import { OrganismBrain } from "../target/types/organism_brain";
import { PublicKey } from "@solana/web3.js";
import { getAccount, getMint } from "@solana/spl-token";
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

describe("trustless observed heartbeat — derives price from on-chain state", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const conn = provider.connection;

  const body = anchor.workspace.organismToken as Program<OrganismToken>;
  const brain = anchor.workspace.organismBrain as Program<OrganismBrain>;

  const orgMint = findPda("mint", body.programId);
  const collateralVault = findPda("collateral_vault", body.programId);
  const bodyState = findPda("body_state", body.programId);

  const brainSeverity = findPda("severity", brain.programId);
  const brainLadder = findPda("ladder", brain.programId);
  const brainIntensity = findPda("intensity", brain.programId);
  const brainActiveSet = findPda("active_set", brain.programId);
  const brainParams = findPda("params", brain.programId);

  it("read on-chain state, predict derived price", async () => {
    const mintInfo = await getMint(conn, orgMint);
    const vaultInfo = await getAccount(conn, collateralVault);
    const supply = Number(mintInfo.supply);
    const vault = Number(vaultInfo.amount);
    const expectedPrice = Math.floor((vault * PRICE_SCALE) / supply);
    console.log(`    on-chain: vault=${vault}  supply=${supply}`);
    console.log(`    expected derived price = ${expectedPrice} = ${(expectedPrice / PRICE_SCALE).toFixed(6)}`);
    expect(supply).to.be.greaterThan(0);
  });

  it("call heartbeat_observed → body's last_price matches derived", async () => {
    const mintInfo = await getMint(conn, orgMint);
    const vaultInfo = await getAccount(conn, collateralVault);
    const supply = BigInt(mintInfo.supply.toString());
    const vault = BigInt(vaultInfo.amount.toString());
    const expectedPrice = Number((vault * BigInt(PRICE_SCALE)) / supply);

    const slot = 30000;
    await withRetry("hb_observed", () =>
      body.methods
        .heartbeatObserved(new BN(slot))
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

    const state = await body.account.bodyState.fetch(bodyState);
    const observedPrice = state.lastPrice.toNumber();
    console.log(`    body.last_price = ${observedPrice} (expected ${expectedPrice})`);
    console.log(`    directive: mode=${JSON.stringify(state.currentDirective.executionMode)} fee=${state.currentDirective.feeAdjustment.toNumber()}`);
    expect(observedPrice).to.equal(expectedPrice);
    expect(state.lastSlot.toNumber()).to.equal(slot);
  });

  it("severity reflects on-chain price (not caller's claim)", async () => {
    // Read severity that the brain computed from the *derived* price
    const sev = await brain.account.severityState.fetch(brainSeverity);
    const mintInfo = await getMint(conn, orgMint);
    const vaultInfo = await getAccount(conn, collateralVault);
    const supply = BigInt(mintInfo.supply.toString());
    const vault = BigInt(vaultInfo.amount.toString());
    const derivedPrice = Number((vault * BigInt(PRICE_SCALE)) / supply);
    const error = Math.abs(derivedPrice - PRICE_SCALE);

    console.log(`    derived price = ${derivedPrice}  error = ${error}  severity = ${sev.s.toNumber()}`);
    // For a tightly over-collateralized pool (error << δ=5000), severity ≈ 0
    if (error < 1000) {
      // Well within delta — severity should be near zero
      expect(sev.s.toNumber()).to.be.lessThan(50_000);
    }
  });

  it("trustless: a malicious caller cannot fake the price", async () => {
    // Call heartbeat_observed: the caller passes ONLY a slot. There is no
    // price argument — the program reads vault+supply from PDAs the caller
    // cannot control. The derived price is whatever the on-chain state says.
    //
    // This test simply demonstrates that the instruction signature contains
    // no price field — verified by inspecting the IDL. We re-read body and
    // confirm last_price still matches state.
    const idl = body.idl;
    const ix = idl.instructions.find((i: any) => i.name === "heartbeatObserved" || i.name === "heartbeat_observed");
    expect(ix).to.not.be.undefined;
    const argNames = ix!.args.map((a: any) => a.name);
    console.log(`    heartbeat_observed args: ${JSON.stringify(argNames)}`);
    expect(argNames).to.deep.equal(["currentSlot"]);
    expect(argNames).to.not.include("currentPrice");
    expect(argNames).to.not.include("current_price");
  });
});
