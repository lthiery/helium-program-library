import { HeliumSubDaos } from "@helium/idls/lib/types/helium_sub_daos";
import { createAtaAndMint, createMint, sendInstructions, toBN } from "@helium/spl-utils";
import { Keypair as HeliumKeypair } from "@helium/crypto";
import * as anchor from "@project-serum/anchor";
import { Program } from "@project-serum/anchor";
import { AccountLayout, getAssociatedTokenAddress } from "@solana/spl-token";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import { assert, expect } from "chai";
import { init as dcInit } from "../packages/data-credits-sdk/src";
import { heliumSubDaosResolvers, stakePositionKey } from "../packages/helium-sub-daos-sdk/src";
import { init as issuerInit } from "../packages/helium-entity-manager-sdk/src";
import { DataCredits } from "../target/types/data_credits";
import { HeliumEntityManager } from "../target/types/helium_entity_manager";
import { burnDataCredits } from "./data-credits";
import { initTestDao, initTestSubdao } from "./utils/daos";
import { DC_FEE, ensureDCIdl, ensureHSDIdl, initWorld } from "./utils/fixtures";
import { createNft } from "@helium/spl-utils";
import { init as cbInit } from "@helium/circuit-breaker-sdk";
import { CircuitBreaker } from "@helium/idls/lib/types/circuit_breaker";
import { VoterStakeRegistry, IDL } from "../deps/helium-voter-stake-registry/src/voter_stake_registry";
import { initVsr, VSR_PID } from "./utils/vsr";
import { BN } from "bn.js";


const EPOCH_REWARDS = 100000000;
const SUB_DAO_EPOCH_REWARDS = 10000000;

describe("helium-sub-daos", () => {
  // Configure the client to use the local cluster.
  anchor.setProvider(anchor.AnchorProvider.local("http://127.0.0.1:8899"));

  const program = new Program<HeliumSubDaos>(
    anchor.workspace.HeliumSubDaos.idl,
    anchor.workspace.HeliumSubDaos.programId,
    anchor.workspace.HeliumSubDaos.provider,
    anchor.workspace.HeliumSubDaos.coder,
    () => {
      return heliumSubDaosResolvers;
    }
  );

  let dcProgram: Program<DataCredits>;
  let hemProgram: Program<HeliumEntityManager>;
  let cbProgram: Program<CircuitBreaker>;
  let vsrProgram: Program<VoterStakeRegistry>;

  let registrar: PublicKey;
  let voter: PublicKey;
  let vault: PublicKey;
  let hntMint: PublicKey;
  let voterKp: Keypair;

  const provider = anchor.getProvider() as anchor.AnchorProvider;
  const me = provider.wallet.publicKey;

  before(async () => {
    dcProgram = await dcInit(
      provider,
      anchor.workspace.DataCredits.programId,
      anchor.workspace.DataCredits.idl
    );
    cbProgram = await cbInit(
      provider,
      anchor.workspace.CircuitBreaker.programId,
      anchor.workspace.CircuitBreaker.idl
    );
    ensureDCIdl(dcProgram);
    ensureHSDIdl(program);
    hemProgram = await issuerInit(
      provider,
      anchor.workspace.HeliumEntityManager.programId,
      anchor.workspace.HeliumEntityManager.idl
    );

    vsrProgram = new Program<VoterStakeRegistry>(
      IDL as VoterStakeRegistry,
      VSR_PID,
      provider,
    );
  });

  it("initializes a dao", async () => {
    const { dao, mint } = await initTestDao(program, provider, EPOCH_REWARDS, provider.wallet.publicKey);
    const account = await program.account.daoV0.fetch(dao!);
    expect(account.authority.toBase58()).eq(me.toBase58());
    expect(account.hntMint.toBase58()).eq(mint.toBase58());
  });

  it("initializes a subdao", async () => {
    const { dao } = await initTestDao(program, provider, EPOCH_REWARDS, provider.wallet.publicKey);
    const { subDao, treasury, mint, treasuryCircuitBreaker } =
      await initTestSubdao(
        program,
        provider,
        provider.wallet.publicKey,
        dao,
      );

    const account = await program.account.subDaoV0.fetch(subDao!);
    const breaker = await cbProgram.account.accountWindowedCircuitBreakerV0.fetch(treasuryCircuitBreaker);

    // @ts-ignore
    expect(Boolean(breaker.config.thresholdType.absolute)).to.be.true;

    expect(account.authority.toBase58()).eq(me.toBase58());
    expect(account.treasury.toBase58()).eq(treasury.toBase58());
    expect(account.dntMint.toBase58()).eq(mint.toBase58());
    expect(account.totalDevices.toNumber()).eq(0);
  });

  describe("with dao and subdao", () => {
    let dao: PublicKey;
    let subDao: PublicKey;
    let hotspotIssuer: PublicKey;
    let treasury: PublicKey;
    let dcMint: PublicKey;
    let rewardsEscrow: PublicKey;
    let stakerPool: PublicKey;
    let makerKeypair: Keypair;
    let subDaoEpochInfo: PublicKey;

    async function createHospot() {
      const ecc = await (await HeliumKeypair.makeRandom()).address.publicKey;
      const hotspotOwner = Keypair.generate().publicKey;

      await dcProgram.methods
        .mintDataCreditsV0({
          amount: toBN(DC_FEE, 8),
        })
        .accounts({ dcMint })
        .rpc({ skipPreflight: true });

      const method = await hemProgram.methods
        .issueHotspotV0({ eccCompact: Buffer.from(ecc), uri: '' })
        .accounts({
          hotspotIssuer,
          maker: makerKeypair.publicKey,
          hotspotOwner,
        })
        .preInstructions([
          ComputeBudgetProgram.setComputeUnitLimit({ units: 350000 }),
        ])
        .signers([makerKeypair]);

      subDaoEpochInfo = (await method.pubkeys()).subDaoEpochInfo!;
      await method.rpc({
        skipPreflight: true,
      });

      return subDaoEpochInfo;
    }

    async function burnDc(
      amount: number
    ): Promise<{ subDaoEpochInfo: PublicKey }> {
      await dcProgram.methods
        .mintDataCreditsV0({
          amount: toBN(amount, 8),
        })
        .accounts({ dcMint })
        .rpc({ skipPreflight: true });

      await sendInstructions(provider, [
        SystemProgram.transfer({
          fromPubkey: me,
          toPubkey: PublicKey.findProgramAddressSync(
            [Buffer.from("account_payer", "utf8")],
            dcProgram.programId
          )[0],
          lamports: 100000000,
        }),
      ]);

      return burnDataCredits({
        program: dcProgram,
        subDao,
        amount,
      });
    }

    beforeEach(async () => {
      ({
        dataCredits: { dcMint },
        subDao: { subDao, treasury, rewardsEscrow, stakerPool },
        dao: { dao },
        issuer: { makerKeypair, hotspotIssuer },
      } = await initWorld(
        provider,
        hemProgram,
        program,
        dcProgram,
        EPOCH_REWARDS,
        SUB_DAO_EPOCH_REWARDS
      ));

      voterKp = Keypair.generate();
      ({registrar, voter, vault, hntMint} = await initVsr(vsrProgram, provider, me, voterKp));
    });

    it("allows tracking hotspots", async () => {
      await createHospot();
      const epochInfo = await program.account.subDaoEpochInfoV0.fetch(
        subDaoEpochInfo
      );
      expect(epochInfo.totalDevices.toNumber()).eq(1);

      const subDaoAcct = await program.account.subDaoV0.fetch(subDao);
      expect(subDaoAcct.totalDevices.toNumber()).eq(1);
    });

    it("allows tracking dc spend", async () => {
      const { subDaoEpochInfo } = await burnDc(10);

      const epochInfo = await program.account.subDaoEpochInfoV0.fetch(
        subDaoEpochInfo
      );
      
      expect(epochInfo.dcBurned.toNumber()).eq(toBN(10, 8).toNumber());
    });

    it("allows vehnt staking", async () => {
      const stakePosition = stakePositionKey(voterKp.publicKey, 0)[0];
      await program.methods.stakeV0({
        vehntAmount: toBN(1, 8),
        depositEntryIdx: 0,
      }).accounts({
        registrar,
        subDao,
        voterAuthority: voterKp.publicKey,
        vsrProgram: VSR_PID,
        stakePosition,
      }).signers([voterKp]).rpc({skipPreflight: true});
    });

    function expectBnAccuracy(expectedBn: anchor.BN, actualBn: anchor.BN, percentUncertainty: number) {
      const upper = expectedBn.mul(new BN(1 + percentUncertainty));
      const lower = expectedBn.mul(new BN(1 - percentUncertainty));
      expect(actualBn.gte(lower));
      expect(actualBn.lte(upper));
    }

    it("calculates subdao rewards", async () => {
      await createHospot();
      const { subDaoEpochInfo } = await burnDc(1600000);
      
      // stake some vehnt
      const stakePosition = stakePositionKey(voterKp.publicKey, 0)[0];
      await program.methods.stakeV0({
        vehntAmount: toBN(15, 8),
        depositEntryIdx: 0,
      }).accounts({
        registrar,
        subDao,
        voterAuthority: voterKp.publicKey,
        vsrProgram: VSR_PID,
        stakePosition,
      }).signers([voterKp]).rpc({skipPreflight: true});
      
      const epoch = (
        await program.account.subDaoEpochInfoV0.fetch(subDaoEpochInfo)
      ).epoch;

      const instr = await program.methods
        .calculateUtilityScoreV0({
          epoch,
        })
        .preInstructions([
          ComputeBudgetProgram.setComputeUnitLimit({ units: 350000 }),
        ])
        .accounts({
          subDao,
          dao,
        });


      const pubkeys = await instr.pubkeys();
      await instr.rpc({ skipPreflight: true });

      const subDaoInfo = await program.account.subDaoEpochInfoV0.fetch(
        subDaoEpochInfo
      );
      const daoInfo = await program.account.daoEpochInfoV0.fetch(
        pubkeys.daoEpochInfo!
      );

      expect(daoInfo.numUtilityScoresCalculated).to.eq(1);

      // 4 dc burned, activation fee of 50, 15 vehnt staked
      // sqrt(1 * 50) * (16)^1/4 * 15 = 212.13203435596426 = 21_213_203_435_596_426
      const totalUtility = new BN("21213203435596426");
      expectBnAccuracy(totalUtility, daoInfo.totalUtilityScore, 0.01);
      expectBnAccuracy(totalUtility, subDaoInfo.utilityScore!, 0.01);
    });

    describe("with staked vehnt", () => {
      let stakePosition: PublicKey;
      beforeEach(async() => {
        stakePosition = stakePositionKey(voterKp.publicKey, 0)[0];
        await program.methods.stakeV0({
          vehntAmount: toBN(1, 8),
          depositEntryIdx: 0,
        }).accounts({
          registrar,
          subDao,
          voterAuthority: voterKp.publicKey,
          vsrProgram: VSR_PID,
          stakePosition,
        }).signers([voterKp]).rpc({skipPreflight: true});
      })

      it("allows unstaking", async () => {
        await program.methods.unstakeV0({
          depositEntryIdx: 0,
        }).accounts({
          registrar,
          stakePosition,
          subDao,
          voterAuthority: voterKp.publicKey,
          vsrProgram: VSR_PID,
        }).signers([voterKp]).rpc({skipPreflight: true});

        assert.isFalse(!!(await provider.connection.getAccountInfo(stakePosition)));
      });

      it("purge a position", async () => {
        await program.methods.purgePositionV0().accounts({
          registrar,
          stakePosition,
          subDao,
          voterAuthority: voterKp.publicKey,
          vsrProgram: VSR_PID,
        }).signers([voterKp]).rpc({skipPreflight: true});

        let acc = await program.account.stakePositionV0.fetch(stakePosition);
        assert.isTrue(acc.purged);
        let subDaoAcc = await program.account.subDaoV0.fetch(subDao);
        assert.equal(subDaoAcc.vehntFallRate.toNumber(), 0);
      });

      it("refreshes a position", async () => {
        await vsrProgram.methods.createDepositEntry(1, {cliff: {}}, null, 183, false).accounts({ // lock for 6 months
          registrar,
          voter,
          vault,
          depositMint: hntMint,
          voterAuthority: voterKp.publicKey,
          payer: voterKp.publicKey,
        }).signers([voterKp]).rpc({skipPreflight: true});
        await vsrProgram.methods.internalTransferLocked(0, 1, toBN(1, 8)).accounts({
          registrar,
          voter,
          voterAuthority: voterKp.publicKey,
        }).signers([voterKp]).rpc({skipPreflight: true});

        await program.methods.refreshPositionV0({
          depositEntryIdx: 0,
        }).accounts({
          registrar,
          stakePosition,
          subDao,
          voterAuthority: voterKp.publicKey,
          vsrProgram: VSR_PID,
        }).signers([voterKp]).rpc({skipPreflight: true});

        const acc = await program.account.stakePositionV0.fetch(stakePosition);
        assert.equal(acc.hntAmount.toNumber(), 0);
        assert.equal(acc.fallRate.toNumber(), 0);
        const subDaoAcc = await program.account.subDaoV0.fetch(subDao);
        assert.equal(subDaoAcc.vehntStaked.toNumber(), 0);
        assert.equal(subDaoAcc.vehntFallRate.toNumber(), 0);

      });

      describe("with calculated rewards", () => {
        let epoch: anchor.BN;
  
        beforeEach(async () => {
          await createHospot();
          const { subDaoEpochInfo } = await burnDc(1600000);
          epoch = (await program.account.subDaoEpochInfoV0.fetch(subDaoEpochInfo))
            .epoch;
          await program.methods
            .calculateUtilityScoreV0({
              epoch,
            })
            .preInstructions([
              ComputeBudgetProgram.setComputeUnitLimit({ units: 350000 }),
            ])
            .accounts({
              subDao,
              dao,
            })
            .rpc({ skipPreflight: true });
        });
  
        it("issues hnt rewards to subdaos and dnt to rewards escrow", async () => {
          const preBalance = AccountLayout.decode(
            (await provider.connection.getAccountInfo(treasury))?.data!
          ).amount;
          const preMobileBalance = AccountLayout.decode(
            (await provider.connection.getAccountInfo(rewardsEscrow))?.data!
          ).amount;
          await sendInstructions(provider, [
            await program.methods
              .issueRewardsV0({
                epoch,
              })
              .accounts({
                subDao,
              })
              .instruction(),
          ]);
  
          const postBalance = AccountLayout.decode(
            (await provider.connection.getAccountInfo(treasury))?.data!
          ).amount;
          const postMobileBalance = AccountLayout.decode(
            (await provider.connection.getAccountInfo(rewardsEscrow))?.data!
          ).amount;
          expect((postBalance - preBalance).toString()).to.eq(
            EPOCH_REWARDS.toString()
          );
          expect(((postMobileBalance - preMobileBalance)).toString()).to.eq(
            ((SUB_DAO_EPOCH_REWARDS / 100) * 94).toString()
          );

          const acc = await program.account.subDaoEpochInfoV0.fetch(subDaoEpochInfo);
          expect(acc.rewardsIssued).to.be.true;
        });
  
        it("claim rewards", async () => {
          // issue rewards
          await sendInstructions(provider, [
            await program.methods
              .issueRewardsV0({
                epoch,
              })
              .accounts({
                subDao,
              })
              .instruction(),
          ]);

          const method = program.methods.claimRewardsV0({
            depositEntryIdx: 0,
            epoch,
          }).accounts({
            registrar,
            stakePosition,
            subDao,
            voterAuthority: voterKp.publicKey,
            vsrProgram: VSR_PID,
          }).signers([voterKp]);
          const { stakerAta } = await method.pubkeys();
          await method.rpc({skipPreflight: true});
          
          const postAtaBalance = AccountLayout.decode(
            (await provider.connection.getAccountInfo(stakerAta!))?.data!
          ).amount;
          assert.isTrue(postAtaBalance <= BigInt(SUB_DAO_EPOCH_REWARDS*6 / 100));
          assert.isTrue(postAtaBalance > BigInt(SUB_DAO_EPOCH_REWARDS*6 / 100 - 5));

        });
      });
    })
    
  });
});
