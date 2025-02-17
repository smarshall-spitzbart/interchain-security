import _ from 'underscore';
import { BlockHistory } from './properties.js';
import cloneDeep from 'clone-deep';
import { strict as assert } from 'node:assert';

/**
 * This model may need updating pending
 * https://github.com/cosmos/ibc/issues/796 (model updated, spec awaiting PR)
 */

import {
  P,
  C,
  UNBONDING_SECONDS_P,
  UNBONDING_SECONDS_C,
  NUM_VALIDATORS,
  MAX_VALIDATORS,
  JAIL_SECONDS,
  BLOCK_SECONDS,
  Event,
} from './constants.js';

import {
  Undelegation,
  Unval,
  Vsc,
  VscMaturity,
  Packet,
  Chain,
  Validator,
  PacketData,
  ConsumerInitiatedSlashPacketData,
  PropertiesSystemState,
  Status,
  ModelInitState,
} from './common.js';

/**
 * Store outbound packets in FIFO order from a given chain.
 * The number of block commits for each packet is stored,
 * and deliverable packets can be consumed once they are sufficiently
 * committed. This mimics real IBC connections.
 */
class Outbox {
  model;
  chain;
  // [packet, num commits]
  fifo: [Packet, number][];

  constructor(model: Model, chain: Chain) {
    this.model = model;
    this.chain = chain;
    this.fifo = [];
  }

  /**
   * Adds a packet to the outbox, with 0 commits.
   * @param data packet data
   */
  add = (data: PacketData) => {
    this.fifo.push([
      {
        data,
        sendHeight: this.model.h[this.chain],
      },
      0,
    ]);
  };

  /**
   * Get and internally delete deliverable packets from the outbox.
   * @param num max num packets to consume
   * @returns A list of deliverable packets
   */
  consume = (num: number): Packet[] => {
    const [available, unavailable] = _.partition(
      this.fifo,
      (e) => 1 < e[1],
    );
    const take = available.slice(0, num);
    this.fifo = available.slice(num).concat(unavailable);
    return take.map((e) => e[0]);
  };

  /**
   * Commit the packets in the outbox. Once a packet has been
   * committed twice it is available for delivery, as per the
   * ibc light-client functioning.
   * 
   * A packet must be committed once to make it to the chain
   * permanently. A packet must be committed twice for IBC
   * to deliver it, in practice, because the IBC light client
   * requires a header H+1 to process a packet in 
   */
  commit = () => {
    // Bump the number of commits by 1
    this.fifo = this.fifo.map((e) => [e[0], e[1] + 1]);
  };
}

class Staking {
  // Model handle
  m;
  // Validator delegations from the sole delegator account.
  // A fixed descending order is used for the initial values to allow
  // easy setup in the SUT.
  delegation: number[];
  // Validator tokens. Tokens are equivalent to power, with a ratio 1:1.
  // Validator tokens are not equal to delegation, because the validator
  // may have tokens from delegation by OTHER delegators, and we model
  // a single delegator.
  tokens: number[];
  // Validator status
  status: Status[];
  // Undelegation queue
  undelegationQ: Undelegation[];
  // Unbonding validator queue
  validatorQ: Unval[];
  // Validator jail timestamp
  // null if validator is not jailed
  jailed: (number | null)[];
  // Initial balance of the sole delegator account.
  // Only a single delegator is modelled, as this seems sufficient
  // to exercise all Interchain Security logic.
  delegatorTokens: number;
  // Unique ID used to count unbonding and redelegation queue entries,
  // as well as unbonding validators.
  opID: number;
  // maps validator id -> power
  // used to compute validator set changes
  changes: Record<Validator, number>;
  // The validators of the last block
  lastVals: number[];
  // The number of tokens of the last block
  // Used to compute validator power changes used in VSCs
  lastTokens: number[];

  constructor(model: Model, { staking }: ModelInitState) {
    this.m = model;
    Object.assign(this, staking);
  }

  /**
   * Compute the new set of active validators
   */
  newVals = () => {
    const valid = (i: number): boolean =>
      1 <= this.tokens[i] && this.jailed[i] === null;
    let vals = _.range(NUM_VALIDATORS);
    // stable sort => breaks ties based on validator
    // address numerical value. This mimics staking module.
    vals = _.sortBy(vals, (i) => -this.tokens[i]);
    vals = vals.filter(valid);
    vals = vals.slice(0, MAX_VALIDATORS);

    assert(
      0 < vals.length,
      'EMPTY VAL SET - not supposed to happen. Model or action generation is wrong.',
    );

    {
      // Is at least 2/3 of new active voting power held by
      // old validators?

      // How much active power does the old val set have?
      const newActivePowerOldVals = this.tokens.reduce(
        (sum, x, i) =>
          // old val and new val
          this.lastVals.includes(i) && vals.includes(i) ? sum + x : sum,
        0,
      );
      // How much active power is there in total?
      const newActivePowerTotal = this.tokens.reduce(
        (sum, x, i) => (vals.includes(i) ? sum + x : sum),
        0,
      );
      if (newActivePowerOldVals < (2 / 3) * newActivePowerTotal) {
        this.m.events.push(Event.MORE_THAN_ONE_THIRD_VAL_POWER_CHANGE);
      }
    }
    return vals;
  };

  endBlockComputeValUpdates = () => {
    const oldVals = this.lastVals;
    const newVals = this.newVals();
    // Bond new validators
    newVals.forEach((i) => {
      this.status[i] = Status.BONDED;
      const before = this.validatorQ.length;
      this.validatorQ = this.validatorQ.filter((e) => e.val != i);
      if (this.validatorQ.length != before) {
        this.m.events.push(Event.REBOND_UNVAL);
      }
    });
    // Start unbonding old validators
    _.difference(oldVals, newVals)
      // sort is necessary because order of iteration
      // defines an implicit mapping of opID to unval.
      // This must match SUT.
      .sort((a, b) => a - b)
      .forEach((i) => {
        const unval: Unval = {
          val: i,
          unbondingHeight: this.m.h[P],
          unbondingTime: this.m.t[P] + UNBONDING_SECONDS_P,
          onHold: true,
          opID: this.opID,
        };
        this.validatorQ.push(unval);
        this.m.ccvP.afterUnbondingInitiated(this.opID);
        this.opID += 1;
        this.status[i] = Status.UNBONDING;
      });

    // Compute updates
    this.changes = {};
    newVals.forEach((i) => {
      if (this.tokens[i] != this.lastTokens[i]) {
        // validator power changed
        this.changes[i] = this.tokens[i];
      }
    });
    _.difference(newVals, oldVals).forEach((i) => {
      // validator bonded
      this.changes[i] = this.tokens[i];
    });
    _.difference(oldVals, newVals).forEach((i) => {
      // validator no longer bonded
      this.changes[i] = 0;
    });

    // Save the valset and their tokens
    // (mimics block commit)
    this.lastVals = newVals;
    this.lastTokens = _.clone(this.tokens);
  };

  endBlockMaturation = () => {
    // Process any unbonding validators that might have matured
    const completedUnvals = this.validatorQ.filter(
      (e: Unval) =>
        e.unbondingTime <= this.m.t[P] &&
        e.unbondingHeight <= this.m.h[P] &&
        !e.onHold,
    );
    completedUnvals.forEach((e: Unval) => {
      this.status[e.val] = Status.UNBONDED;
      this.m.events.push(Event.COMPLETE_UNVAL_IN_ENDBLOCK);
    });
    this.validatorQ = this.validatorQ.filter(
      (e) => !completedUnvals.includes(e),
    );

    // Process any undelegations that might have matured
    const processedUndels = this.undelegationQ.filter(
      (e) =>
        e.completionTime <= this.m.t[P] &&
        e.willBeProcessedByStakingModule,
    );
    processedUndels.forEach(
      (e: Undelegation) => (e.willBeProcessedByStakingModule = false),
    );
    const completedUndels = processedUndels.filter((e) => !e.onHold);
    if (completedUndels.length < processedUndels.length) {
      this.m.events.push(Event.SOME_UNDELS_EXPIRED_BUT_NOT_COMPLETED);
    }
    this.undelegationQ = this.undelegationQ.filter(
      (e: Undelegation) => !completedUndels.includes(e),
    );
    if (0 < completedUndels.length) {
      this.m.events.push(Event.COMPLETE_UNDEL_IN_ENDBLOCK);
    }
    // Refund completed undelegations
    this.delegatorTokens += completedUndels.reduce(
      (x, e) => x + e.balance,
      0,
    );
  };

  endBlock = () => {
    this.endBlockComputeValUpdates();
    this.endBlockMaturation();
  };

  delegate = (val: Validator, amt: number) => {
    this.delegatorTokens -= amt;
    this.tokens[val] += amt;
    this.delegation[val] += amt;
  };

  undelegate = (val: Validator, amt: number) => {
    if (this.delegation[val] < amt) {
      this.m.events.push(Event.INSUFFICIENT_SHARES);
      return;
    }
    this.tokens[val] -= amt;
    this.delegation[val] -= amt;
    const und: Undelegation = {
      val: val,
      creationHeight: this.m.h[P],
      completionTime: this.m.t[P] + UNBONDING_SECONDS_P,
      balance: amt,
      initialBalance: amt,
      onHold: true,
      opID: this.opID,
      willBeProcessedByStakingModule: true,
    };
    this.undelegationQ.push(und);
    this.m.ccvP.afterUnbondingInitiated(this.opID);
    this.opID += 1;
  };

  slash = (val: Validator, infractionHeight: number) => {
    const valid = (e: Undelegation): boolean =>
      e.val === val &&
      infractionHeight <= e.creationHeight &&
      (this.m.t[P] < e.completionTime || e.onHold);
    const ubds: Undelegation[] = this.undelegationQ.filter(valid);
    if (infractionHeight < this.m.h[P]) {
      ubds.forEach(() => {
        this.m.events.push(Event.SLASH_UNDEL);
      });
    }
  };

  jailUntil = (val: Validator, timestamp: number) => {
    this.jailed[val] = timestamp;
    this.m.events.push(Event.JAIL);
  };

  unbondingCanComplete = (opID: number) => {
    {
      // Allow maturity of relevant validator
      const e = _.find(this.validatorQ, (e) => e.opID === opID);
      if (e) {
        e.onHold = false;
        this.m.events.push(Event.SET_UNVAL_HOLD_FALSE);
        return;
      }
    }
    {
      // Allow maturity of relevant unbonding delegation
      const e = _.find(this.undelegationQ, (e) => e.opID === opID);
      if (e) {
        if (e.completionTime <= this.m.t[P]) {
          this.delegatorTokens += e.balance;
          this.undelegationQ = this.undelegationQ.filter((x) => x !== e);
          this.m.events.push(Event.COMPLETE_UNDEL_IMMEDIATE);
        } else {
          e.onHold = false;
          this.m.events.push(Event.SET_UNDEL_HOLD_FALSE);
        }
      }
    }
  };

  valUpdates = () => {
    return _.clone(this.changes);
  };
}

class CCVProvider {
  m;
  // height of onChanOpenConfirm event
  initialHeight: number;
  // next id to use
  vscID: number;
  // map ids to height of sending
  // used to calculate infraction height from consumer initiated slashing
  vscIDtoH: Record<number, number>;
  // map ids to unbonding operation ids
  // used to mature unbonding operations when receiving maturity packets
  vscIDtoOpIDs: Map<number, number[]>;
  // validators who have been slashed since last VSC
  downtimeSlashAcks: Validator[];
  // is a validator tombstoned?
  tombstoned: boolean[];
  // unbonding operations to be completed in EndBlock
  matureUnbondingOps: number[];
  // queue of packets to be processed
  // there is only one consumer so global queue is not needed
  queue: (ConsumerInitiatedSlashPacketData | VscMaturity)[];

  constructor(model: Model, { ccvP }: ModelInitState) {
    this.m = model;
    Object.assign(this, ccvP);
  }

  endBlockCIS = () => {
    this.vscIDtoH[this.vscID] = this.m.h[P] + 1;
    this.processPackets();
  };

  endBlockVSU = () => {
    // notify staking module that unbonding operations can complete
    this.matureUnbondingOps.forEach((opID) => {
      this.m.staking.unbondingCanComplete(opID);
    });
    this.matureUnbondingOps = [];
    const valUpdates = this.m.staking.valUpdates();
    if (
      0 < _.keys(valUpdates).length ||
      this.vscIDtoOpIDs.has(this.vscID)
    ) {
      if (0 === _.keys(valUpdates).length) {
        this.m.events.push(Event.SEND_VSC_NOT_BECAUSE_CHANGE);
      }
      if (0 < this.downtimeSlashAcks.length) {
        this.m.events.push(Event.SEND_VSC_WITH_DOWNTIME_ACK);
      } else {
        this.m.events.push(Event.SEND_VSC_WITHOUT_DOWNTIME_ACK);
      }
      const data: Vsc = {
        vscID: this.vscID,
        updates: valUpdates,
        downtimeSlashAcks: this.downtimeSlashAcks,
      };
      this.downtimeSlashAcks = [];
      this.m.outbox[P].add(data);
    }
    this.vscID += 1;
  };

  endBlock = () => {
    this.endBlockCIS();
    this.endBlockVSU();
  };

  onReceive = (data: PacketData) => {

    // Drop slash packets for double-sign infraction
    if ('isDowntime' in data && ! data.isDowntime) {
      this.m.events.push(Event.RECEIVE_DOUBLE_SIGN_SLASH_REQUEST);
      return;
    }

    /*
    TODO: tidy up before merging to main
    This is some quick prototyping to get the tests passing
    We have 1 consumer chain so the slash queue is the global queue
    if the queue is empty we can just process the packet.
    */
    if (this.queue.length == 0 && !('isDowntime' in data)) {
      // Skip the queue
      this.onReceiveVSCMatured(data as VscMaturity);
    } else {
      this.queue.push(data);
    }
  };

  processPackets = () => {
    this.queue.forEach((data) => {
      // It's sufficient to use isDowntime field as differentiator
      if ('isDowntime' in data) {
        this.onReceiveSlash(data);
      } else {
        this.onReceiveVSCMatured(data);
      }
    });
    this.queue = [];
  };

  onReceiveVSCMatured = (data: VscMaturity) => {
    if (this.vscIDtoOpIDs.has(data.vscID)) {
      this.vscIDtoOpIDs.get(data.vscID)!.forEach((opID: number) => {
        this.matureUnbondingOps.push(opID);
      });
      this.vscIDtoOpIDs.delete(data.vscID);
    }
  };

  onReceiveSlash = (data: ConsumerInitiatedSlashPacketData) => {

    // Check validator status
    if (this.m.staking.status[data.val] === Status.UNBONDED) {
      this.m.events.push(Event.RECEIVE_SLASH_REQUEST_UNBONDED);
      return;
    }

    //
    // Soft opt out logic
    //

    // Sort token powers from lowest to highest
    const tokens = this.m.staking.tokens;
    const sortedTokens = Object.values(tokens).sort((a, b) => a - b);

    // Get total power (token is 1:1 to power)
    let totalPower = 0;
    sortedTokens.forEach((token, _) => {
      totalPower += token;
    });

    let smallestNonOptOutPower = -1;

    // Soft opt out threshold is set as 0 as for now soft opt-out is disabled. 
    // See createConsumerGenesis() in diff test setup.go
    const softOptOutThreshold = 0;

    if (softOptOutThreshold == 0) {
      smallestNonOptOutPower = 0
    } else {
      // get power of the smallest validator that cannot soft opt out
      let powerSum = 0;

      for (let i = 0; i < sortedTokens.length; i++) {
        powerSum += sortedTokens[i];
        if (powerSum / totalPower > softOptOutThreshold) {
          smallestNonOptOutPower = sortedTokens[i];
          break;
        }
      }
    }
    
    if (smallestNonOptOutPower == -1) {
      throw new Error('control flow should not reach here');
    }

    if (this.m.staking.tokens[data.val] < smallestNonOptOutPower) {
      // soft opt out if validator power is smaller than smallest power which needs to be up
      return;
    }

    this.m.events.push(Event.RECEIVE_DOWNTIME_SLASH_REQUEST);


    if (this.tombstoned[data.val]) {
      return;
    }

    // jail validator
    this.m.staking.jailUntil(data.val, this.m.t[P] + JAIL_SECONDS);
    // update slash acks
    this.downtimeSlashAcks.push(data.val);
 
  };

  afterUnbondingInitiated = (opID: number) => {
    if (!this.vscIDtoOpIDs.has(this.vscID)) {
      this.vscIDtoOpIDs.set(this.vscID, []);
    }
    this.vscIDtoOpIDs.get(this.vscID)!.push(opID);
  };
}

class CCVConsumer {
  m;
  // maps consumer height h to the id of the last vscid
  // received at height h-1
  hToVscID: Record<number, number>;
  // validator power changes pending aggregation
  pendingChanges: Record<Validator, number>[];
  // maps vscid to earliest timestamp to mature
  maturingVscs: Map<number, number>;
  // is there an outstanding downtime operation for a validator?
  outstandingDowntime: boolean[];
  // array of validators to power
  // value null if validator is not known to consumer
  consumerPower: (number | null)[];

  constructor(model: Model, { ccvC }: ModelInitState) {
    this.m = model;
    Object.assign(this, ccvC);
  }

  beginBlock = () => {
    this.hToVscID[this.m.h[C] + 1] = this.hToVscID[this.m.h[C]];
  };

  endBlockVSU = () => {
    // Gather all matured VSCs
    const matured = (() => {
      const ret: number[] = [];
      this.maturingVscs.forEach((time, vscID) => {
        if (time <= this.m.t[C]) {
          ret.push(vscID);
        }
      });
      return ret;
    })();
    // Send a maturity packet for each matured VSC
    matured.forEach((vscID) => {
      const data: VscMaturity = { vscID };
      this.m.events.push(Event.CONSUMER_SEND_MATURATION);
      this.m.outbox[C].add(data);
      this.maturingVscs.delete(vscID);
    });

    // Aggregate and apply validator voting power changes
    const changes = (() => {
      const ret: Map<Validator, number> = new Map();
      this.pendingChanges.forEach((updates) => {
        Object.entries(updates).forEach(([val, power]) =>
          ret.set(parseInt(val), power),
        );
      });
      return ret;
    })();

    this.pendingChanges = [];

    changes.forEach((power, val) => {
      if (0 < power) {
        if (this.consumerPower[val] === null) {
          this.m.events.push(Event.CONSUMER_ADD_VAL);
        } else {
          this.m.events.push(Event.CONSUMER_UPDATE_VAL);
        }
        this.consumerPower[val] = power;
      } else {
        this.consumerPower[val] = null;
        this.m.events.push(Event.CONSUMER_DEL_VAL);
      }
    });
  };

  endBlock = () => {
    this.endBlockVSU();
  };

  onReceive = (data: PacketData) => {
    this.onReceiveVSC(data as Vsc);
  };

  onReceiveVSC = (data: Vsc) => {
    this.hToVscID[this.m.h[C] + 1] = data.vscID;
    this.pendingChanges.push(data.updates);
    this.maturingVscs.set(data.vscID, this.m.t[C] + UNBONDING_SECONDS_C);
    data.downtimeSlashAcks.forEach((val: Validator) => {
      this.m.events.push(Event.RECEIVE_DOWNTIME_SLASH_ACK);
      this.outstandingDowntime[val] = false;
    });
  };

  sendSlashRequest = (
    val: Validator,
    infractionHeight: number,
    isDowntime: boolean,
  ) => {
    if (isDowntime && this.outstandingDowntime[val]) {
      this.m.events.push(Event.DOWNTIME_SLASH_REQUEST_OUTSTANDING);
      return;
    }
    const data: ConsumerInitiatedSlashPacketData = {
      val,
      vscID: this.hToVscID[infractionHeight],
      isDowntime,
    };
    this.m.outbox[C].add(data);
    if (isDowntime) {
      this.m.events.push(Event.SEND_DOWNTIME_SLASH_REQUEST);
      this.outstandingDowntime[val] = true;
    } else {
      this.m.events.push(Event.SEND_DOUBLE_SIGN_SLASH_REQUEST);
    }
  };
}

class Model {
  h;
  t; // The network outboxes for each chain
  outbox: Record<string, Outbox> = {
    provider: new Outbox(this, P),
    consumer: new Outbox(this, C),
  };
  staking: Staking;
  ccvP: CCVProvider;
  ccvC: CCVConsumer;
  history: BlockHistory;
  events: Event[];

  constructor(
    history: BlockHistory,
    events: Event[],
    state: ModelInitState,
  ) {
    this.history = history;
    this.events = events;
    this.h = state.h;
    this.t = state.t;
    this.staking = new Staking(this, state);
    this.ccvP = new CCVProvider(this, state);
    this.ccvC = new CCVConsumer(this, state);
    // Implicitly, there is already a partial order between
    // model initial blocks on P and C because C starts with
    // the same validator set as P (and thus must have received
    // a packet from P).
    this.history.partialOrder.deliver(C, 0, 0);
    this.history.commitBlock(P, this.propertiesSystemState());
    this.history.commitBlock(C, this.propertiesSystemState());
    this.beginBlock(P, BLOCK_SECONDS);
    this.beginBlock(C, BLOCK_SECONDS);
  }

  propertiesSystemState = (): PropertiesSystemState => {
    return cloneDeep({
      h: this.h,
      t: this.t,
      tokens: this.staking.tokens,
      status: this.staking.status,
      undelegationQ: this.staking.undelegationQ,
      delegatorTokens: this.staking.delegatorTokens,
      consumerPower: this.ccvC.consumerPower,
      vscIDtoH: this.ccvP.vscIDtoH,
      hToVscID: this.ccvC.hToVscID
    });
  };

  /*
  ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
  ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
  MODEL API
  */

  delegate = (val: number, amt: number) => {
    this.staking.delegate(val, amt);
  };

  undelegate = (val: number, amt: number) => {
    this.staking.undelegate(val, amt);
  };

  consumerInitiatedSlash = (
    val: number,
    infractionHeight: number,
    isDowntime: boolean,
  ) => {
    this.ccvC.sendSlashRequest(val, infractionHeight, isDowntime);
  };

  updateClient = (_: Chain) => {
    // noop. We do not explicitly model the client update process
    // but we must call this function at appropriate times in order
    // to test the SUT using this model. This is because
    // if we allow too much time to elapse between updates, the light
    // clients in the SUT will expire, and the test will fail.
  };

  deliver = (chain: Chain, num: number) => {
    if (chain === P) {
      this.outbox[C].consume(num).forEach((p) => {
        this.history.partialOrder.deliver(P, p.sendHeight, this.h[P]);
        this.ccvP.onReceive(p.data);
      });
    }
    if (chain === C) {
      this.outbox[P].consume(num).forEach((p) => {
        this.history.partialOrder.deliver(C, p.sendHeight, this.h[C]);
        this.ccvC.onReceive(p.data);
      });
    }
  };

  endAndBeginBlock = (chain: Chain) => {
    this.endBlock(chain);
    this.beginBlock(chain, BLOCK_SECONDS);
  };

  /*
  END MODEL API
  ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
  ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
  */

  endBlock = (chain: Chain) => {
    if (chain === P) {
      // Mimic real provider app behavior
      this.staking.endBlock();
      this.ccvP.endBlock();
    }
    if (chain === C) {
      this.ccvC.endBlock();
    }
    // Commit all packets sent by the chain
    this.outbox[chain].commit();
    // Record a slice of the system state for checking properties
    this.history.commitBlock(chain, this.propertiesSystemState());
  };

  beginBlock = (chain: Chain, dt: number) => {
    this.h[chain] += 1;
    this.t[chain] += dt;
    if (chain === P) {
      // No op. There is nothing interesting
      // to do at the beginning of a block on P.
    }
    if (chain === C) {
      this.ccvC.beginBlock();
    }
  };
}

export { Outbox, Model };
