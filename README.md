**Nyxanic** is a control-theoretic stablecoin on Solana that maintains a hard $1.00 peg not by deploying capital, but by governing flow — adjusting fees, spreads, sequencing, throttling, routing, supply, collateral ratios, and ultimately suspending transactions, all through closed-form deterministic mathematics, atomically, without external incentives, subsidies, or human intervention.

---

**2. WHY**

**The Problem**

Stablecoins to date exhibit three structural lackings: they rely on external incentives that expire, they over-collateralize into capital paralysis or under-collateralize into collapse, and they fragment liquidity across pools and routers. Each is a dependency on something outside the system — a subsidy, a reserve, a market structure — and each fails when that dependency withdraws.

**The Vision**

Nyxanic treats the stablecoin as a living organism: it perceives disturbance, reacts proportionally, escalates intelligently, and rests when calm. The architecture rests on two principles from control theory. First: if you can measure the error, you can correct it. Second: the harder the system is attacked, the more energy it generates to defend itself. Stress produces revenue. Friction funds recovery. The organism strengthens under pressure, then returns to dormancy when the pressure ceases.

---

**3. SEE IT LIVE**

**3.1 The Organism Under Stress**

https://github.com/user-attachments/assets/d9c29814-6a0f-4cc5-8a03-fd6d132dfe85


**3.2 Hands On**



https://github.com/user-attachments/assets/6964e360-e4a1-4652-afa4-8a66566b31d9



**3.3 Run It Yourself**

```bash
git clone https://github.com/morphym/nyxanic
cd nyxanic && npm install
npx ts-node scripts/terminal.ts
```

The organism does not sleep. It waits.

---

**4 Understand-it**

For full mathematics specification, derivation, and the complete architecture, It;s recomended to read the whitepaper

[pawit.co/whitepaper/nyxanic.pdf](https://pawit.co/whitepaper/nyxanic.pdf)

---

**How (Architecture at glance)**


<img width="3450" height="2358" alt="Untitled-2026-05-10-0347" src="https://github.com/user-attachments/assets/6f3e6086-f479-4749-b510-6c2e5b76635c" />

</br>

**5.1 The Split**

Contract A holds what is. Contract B holds what to do about it.

**5.2 Loop**

Every transaction invokes the Brain via CPI, atomically. <br/>
The Brain measures error against the peg, computes severity, evaluates the ladder, returns a directive. </br>
The Body executes. </br>
The loop closes within a single Solana transaction.

No off-chain latency. No oracle dependency. No external liveness.

**5.3 Ladder**

Eight rungs, lightest to heaviest:

| Rung | Variable                     |
| :--- | :--------------------------- |
| ℓ₁   | Dynamic Fee Rate             |
| ℓ₂   | Spread Width Control         |
| ℓ₃   | Transaction Sequencing       |
| ℓ₄   | Transaction Speed (Throttle) |
| ℓ₅   | Liquidity Routing            |
| ℓ₆   | Mint and Burn Rate           |
| ℓ₇   | Collateral Ratio Adjustment  |
| ℓ₈   | Transaction Stopping         |

Each rung activates only when all lighter rungs have been exhausted, permuted, and intensified. The ladder climbs one rung at a time. No jumps. Descent is slower than ascent — hysteresis prevents oscillation.

**5.4 Math**

The severity function maps price deviation to a bounded activation signal. The ladder transitions under time-gated rules. Intensity dynamics govern how each rung strengthens or decays. Permutations at medium severity break adversarial prediction. All computation is fixed-point, deterministic, domain-independent — identical across every Solana validator.<br/>

The mathematics is closed-form, deterministic, and domain-independent. 

For complete definitions, derivations, parameter choices, and measured behavior, see the [whitepaper](pawit.co/whitepaper/nyxanic.pdf)

**6. Properties**

| Property                   | Description                                                                                                                                                        |
| :------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Capital Efficiency**     | Reserves remain idle under normal operation. Capital deploys only at the heaviest rungs, and then only to the minimum extent required.                             |
| **Cost Frugality**         | Constant memory, O(1) operations, self-erasing state. The heartbeat consumes under 2% of Solana's per-transaction compute budget at all severity levels.           |
| **Adversarial Resistance** | Deterministic permutations prevent prediction of the next active organ. Hysteresis prevents oscillation attacks. The terminal stop-flag is unconditional.          |
| **Trustlessness**          | After birth, no key controls the system. All accounts are PDAs. The deployer is no longer privileged. Program upgrade authority may be set to None.                |
| **Determinism**            | Fixed-point integer arithmetic throughout. No floating point. No hardware-dependent nondeterminism. Every validator computes identical results.                    |
| **Observability**          | All nervous activity is publicly visible through Anchor events emitted on every transaction. Full state may be reconstructed without reading any account directly. |
| **Trustless Price Source** | The observed price derives from on-chain AMM state: vault balance divided by supply. No caller-supplied price. No oracle attack surface.                           |

Recomended to read the whitepaper, for all derivation of properties, and more inherint property it has.

---

**7. Measured**

**7.1 On-Chain Verification**

All measurements derive from a complete on-chain test suite. Each test is an Anchor instruction executed against deployed programs on Solana devnet:

```sh
&tests/
birth.ts              heartbeat.ts          permutation.ts
body_variables.ts     lp_trade.ts           random.ts
collateral_target.ts  ntt_quota.ts          rebalance.ts
cu_measure.ts         observed_heartbeat.ts seal.ts
full_birth.ts         organism.ts
```

visit [/test](/test/)

`cu_measure.ts` directly instruments compute units consumed per heartbeat scenario. The remaining tests exercise severity, hysteresis, ladder transitions, intensity dynamics, permutations, supply correction, collateral ratio enforcement, and authority handoff.. all verifiable on-chain.

The first complete token deployed during creation, not a test token:

4x2VEu8TGdiJdFqBEdnXAG2EvZPn5m27AoDThbtmLiv5

Its transaction history on devnet records the full birth sequence, heartbeat evaluations, LP trades, and ladder escalations. Verify by inspecting the chain directly, or run the suite yourself:

```sh
anchor test --skip-build
```

**7.2 Compute Cost**

<img width="1730" height="521" alt="Screenshot" src="https://www.pawit.co/some-data/A55E03E2-CA7E-4848-B267-706BD473A128_1_201_a.jpeg" />

</br>

The heartbeat consumes essentially flat compute across all severity levels. </br>
Pure mathematics — Hill function, ladder transition, intensity update..— matches the original estimate of $~5,000 CU$. </br>
Anchor framework overhead adds a constant $~20,000 CU$ for PDA validation, borsh deserialization, and CPI return-data plumbing.


**7.3**

Cost variation remains under 1% between full rest and catastrophic depeg. A complete swap-with-heartbeat lands near $35,000 CU$ — $2.5%$ of Solana's per-transaction budget.

**7.4 Servity Measure**

This servity measurement was captured on the chain, see section 7.1 test code, to produce again on the chain;

<img width="1554" height="648" alt="Screenshot" src="https://github.com/user-attachments/assets/e4def253-00bc-482d-b486-03d5049b8776" />

</br>

Servity is considered reasonable, and also most other stablecoin actually orbit arround 1 to 0.999 price for brief second.

For this organism, even servity of 0.995 is considered 0.5 medium servity.

**7.4 Implication**

The architecture does not become more expensive under stress. It does not consume additional compute as severity rises. The system is as cheap at rest as it is under attack.

---

**8. Self-Sustainability**

The system extracts energy from the very disturbances that threaten it.

1. Fee Metabolism — every swap mints extracted spread and fee into the Fee Collector treasury. Higher volume, more energy.
2. Spread Harvesting — widened spreads during volatility extract the difference. The system profits from chaos.
3. Friction Revenue — dynamic fees on destabilizing transactions generate income precisely when under stress.
4. Treasury-Funded Supply Contraction — when the brain demands supply reduction (rung ℓ₆), the body burns from accumulated treasury. No external capital. No autonomous mint.

**8.2 Cycle**

Stress → fees → treasury → contraction → recovery → dormancy. 
The organism strengthens under attack because attack feeds it.

**8.3 Constraint**

Positive supply deltas emit a signal event only. The body never autonomously mints unbacked supply.

---

**9. Deployment & Documentation**

All the deployment instruction, program addresses, birth sequence, and full api documentation reside in
[docs/start.md](docs/start.md) page, readme remain the portal, depth is elsewhere.

---

**10. Conclusion**

Small complex mathematics. Vast emergent capability. Constant vigilance.

---

References: Whitepaper </br>

[pawit.co/whitepaper/nyxanic.pdf](pawit.co/whitepaper/nyxanic.pdf)

Time of Creation: 2 Aprl.

