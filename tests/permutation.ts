import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { OrganismToken } from "../target/types/organism_token";
import { OrganismBrain } from "../target/types/organism_brain";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { expect } from "chai";
import BN from "bn.js";

const PRICE_SCALE = 1_000_000;

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

describe("§2.9 permutation — devnet", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const body = anchor.workspace.organismToken as Program<OrganismToken>;
  const brain = anchor.workspace.organismBrain as Program<OrganismBrain>;
  const wallet = provider.wallet as anchor.Wallet;

  const bodyState = findPda("body_state", body.programId);
  const brainSeverity = findPda("severity", brain.programId);
  const brainLadder = findPda("ladder", brain.programId);
  const brainIntensity = findPda("intensity", brain.programId);
  const brainActiveSet = findPda("active_set", brain.programId);
  const brainParams = findPda("params", brain.programId);

  it("initialize active_set account (one-time)", async () => {
    try {
      await brain.methods
        .initializeActiveSet()
        .accounts({
          activeSet: brainActiveSet,
          authority: wallet.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc({ commitment: "confirmed" });
      console.log("    active_set initialized:", brainActiveSet.toBase58());
    } catch (e: any) {
      if (String(e).includes("already in use")) {
        console.log("    active_set already exists");
      } else throw e;
    }

    const acc = await brain.account.activeSetState.fetch(brainActiveSet);
    console.log("    initial order:", Array.from(acc.order));
    expect(Array.from(acc.order)).to.deep.equal([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  async function heartbeat(p: number, dir: number, slot: number) {
    return withRetry("hb", () =>
      body.methods
        .heartbeat(price(p), dir, new BN(slot))
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
  }

  async function readActiveSet(): Promise<number[]> {
    const acc = await brain.account.activeSetState.fetch(brainActiveSet);
    return Array.from(acc.order);
  }

  it("drive into medium severity band → active_set permutes", async () => {
    // Phase 1: warm-up to climb ladder so we have ≥ 2 active rungs
    let slot = 5000;
    for (let i = 0; i < 30; i++) {
      await heartbeat(0.992, 1, slot++); // severity ~0.8 (high band)
    }
    const ladderAfterWarmup = await brain.account.ladderState.fetch(brainLadder);
    console.log(`    after warmup: rung=${ladderAfterWarmup.rung}`);

    // Phase 2: drift to medium band (price ~0.9965 → severity ~0.25)
    const orders: string[] = [];
    let lastOrder = JSON.stringify(await readActiveSet());
    orders.push(lastOrder);

    for (let i = 0; i < 12; i++) {
      await heartbeat(0.9965, 1, slot++);
      const cur = JSON.stringify(await readActiveSet());
      if (cur !== lastOrder) {
        orders.push(cur);
        lastOrder = cur;
      }
    }

    console.log(`    distinct active_set orderings observed: ${orders.length}`);
    orders.forEach((o, i) => console.log(`      [${i}] ${o}`));

    // Should observe at least one permutation when in medium band
    expect(orders.length).to.be.greaterThan(1);
  });

  it("exit medium band → permutations_tried resets to 0", async () => {
    // Drop to peg → severity 0 → permutation reset
    let slot = 5050;
    for (let i = 0; i < 5; i++) {
      await heartbeat(1.0, -1, slot++);
    }
    const ladder = await brain.account.ladderState.fetch(brainLadder);
    console.log(`    permutations_tried after exit: ${ladder.permutationsTried}`);
    expect(ladder.permutationsTried).to.equal(0);
  });
});
