import ACTORS from './actors';
import ACTIONS from './actions';
import PLANS from './plans';
import ALERTERS from './alerters';
import createClient from './testchain';
import assert from 'assert';
import prng from '../src/prng';
import castArray from 'lodash/castArray';
import Maker from '@makerdao/dai';
import McdPlugin from '@makerdao/dai-plugin-mcd';
import debug from 'debug';
import fs from 'fs';
import path from 'path';
import { filter } from './helpers/utils';
import defaultsDeep from 'lodash/defaultsDeep';
const log = debug('testrunner:engine');
import { sleep } from './helpers/utils';

export default class Engine {
  constructor(options = {}) {
    // Will contain list of dai.js lib options (if passed)
    this._daijsConfig = null;
    // Will contain list of addresses for dai.js lib (if passed)
    this._addressesConfig = {};

    const { plans, actions, actors } = options;
    assert(
      plans || (actors && actions),
      'Must provide { plans } OR { actors, actions }, but not both'
    );

    // Check if config file exist and accesible
    if (options.config) {
      options.config = path.resolve(options.config);
      assert(fs.existsSync(options.config), 'Configuration file must exist');
      this._daijsConfig = require(options.config);
    }

    // Check if addresses.json config file exist and accesible
    if (options.addressesConfig) {
      options.addressesConfig = path.resolve(options.addressesConfig);
      assert(
        fs.existsSync(options.addressesConfig),
        'Addresses config file must exist'
      );
      this._addressesConfig = require(options.addressesConfig);
    }

    if (options.iterations === undefined) {
      options.iterations = 1;
    }

    this.rng = new prng({ seed: options.seed });

    this._options = options;
  }

  async _runOnce(report, i, failAtIndex) {
    const plan = this._options.plans
      ? this._importPlans(this._options.plans)
      : null;

    let actors;
    log('importing actors...');
    try {
      actors = await this._importActors(this._options.actors || plan.actors);
    } catch (error) {
      return failAtIndex(-1, error);
    }

    const actions = await this._randomActionCheck(
      this._options.actions || plan.actions,
      actors
    );

    log('running actions...');
    for (const action of actions) {
      if (!report.success) break;
      try {
        let [actorName, parametrizedAction] = action;
        const actionName =
          typeof parametrizedAction === 'object'
            ? parametrizedAction[0]
            : parametrizedAction;
        const actionConfig =
          typeof parametrizedAction === 'object'
            ? parametrizedAction[1] || {}
            : {};
        const importedAction = ACTIONS[actionName];
        assert(importedAction, `Could not import action: ${actionName}`);

        const importedActor = actors[actorName];
        assert(importedActor, `Missing actor: ${actorName}`);

        const result = await this._runAction(
          importedAction,
          importedActor,
          actionConfig
        );
        report.results.push(result);
        report.completed.push(action);
      } catch (error) {
        if (this._options.continueOnFailure) {
          report.results.push(-1);
          report.completed.push(action);
        } else {
          return failAtIndex(report.results.length, error);
        }
      }
    }
  }

  async run() {
    log('running...');

    // TODO set this based on whether the plans/actions require a testchain
    const shouldUseTestchainClient = false;

    // use this to share state across all actions in a plan
    this._context = {};

    const report = (this.report = {
      results: [],
      success: true,
      completed: []
    });
    const failAtIndex = (index, error) => {
      report.success = false;
      report.error = error;
      report.errorIndex = index;
      return report;
    };

    if (shouldUseTestchainClient) {
      this._client = createClient();
      log(await this._client.api.listAllChains());
    } else if (this._options.url) {
      // n.b. this means that Maker is only set up when url is explicitly set--
      // this is only temporary
      try {
        log('setting up maker instance...');

        let options = {
          url: this._options.url,
          plugins: [
            [
              McdPlugin,
              { addressOverrides: this._addressesConfig, prefetch: false }
            ]
          ],
          log: false,
          smartContract: {
            addressOverrides: this._addressesConfig
          }
        };
        // Check if we do have configuration options loaded from file
        // We have to set them for daijs lib.
        // And because our options has higher priority we will override everything
        // except our predefined options
        if (this._daijsConfig) {
          options = defaultsDeep({}, options, this._daijsConfig);
        }

        this._maker = await Maker.create('http', options);
        log('succeeded in setting up maker instance.');
      } catch (error) {
        return failAtIndex(-1, error);
      }
    }

    let i = 0;
    do {
      await this._runOnce(report, i, failAtIndex);
      await sleep(this._options.sleep * 1000);
    } while (++i !== parseInt(this._options.iterations));

    return report;
  }

  // `level` is similar to log levels -- e.g. if the level is "error", an
  // alerter should not produce any output unless there's an error
  async alert(level, alerters) {
    assert(this.report, 'Nothing to alert on yet');

    alerters = castArray(alerters);
    for (const name of alerters) {
      const factory = ALERTERS[name];
      assert(factory, `Unrecognized alerter name: ${name}`);
      await factory()(level, this.report);
    }
  }

  async stop() {
    // TODO
  }

  async _runAction(action, actor, config) {
    const { before, operation, after } = action;
    if (actor.address) this._maker.useAccountWithAddress(actor.address);

    const beforeResult = before
      ? await this._runStep(before.bind(action), actor, undefined, config)
      : undefined;
    const result = await this._runStep(
      operation.bind(action),
      actor,
      beforeResult,
      config
    );

    if (after) await this._runStep(after.bind(action), actor, result, config);
    return result;
  }

  async _filterActions(actions, importedActor) {
    return filter(actions, async action => {
      const importedAction =
        ACTIONS[typeof action === 'object' ? action[0] : action];
      const actionConfig = typeof action === 'object' ? action[1] || {} : {};
      if (importedAction.precondition === undefined) return true;
      if (importedActor.address)
        this._maker.useAccountWithAddress(importedActor.address);
      return this._runStep(
        importedAction.precondition.bind(importedAction),
        importedActor,
        undefined,
        actionConfig
      );
    });
  }

  _runStep(step, actor, lastResult, config) {
    return step(actor, {
      maker: this._maker,
      context: this._context,
      config,
      lastResult,
      rng: this.rng
    });
  }

  async _importActors(actors) {
    const result = {};
    for (let name of Object.keys(actors)) {
      assert(
        ACTORS[actors[name]],
        `Could not import actor: { ${name}: ${actors[name]} }`
      );
      result[name] = await ACTORS[actors[name]](
        name,
        this._maker,
        this._options
      );
      log(`imported actor: ${name}`);
    }
    return result;
  }

  _importPlans(plans) {
    return plans.reduce(
      (result, plan) => {
        const importedPlan = PLANS[plan];
        assert(importedPlan, `Could not import plan: ${plan}`);
        result.actors = { ...result.actors, ...importedPlan.actors };
        const actions =
          importedPlan.mode === 'random'
            ? this.rng.shuffle(importedPlan.actions)
            : importedPlan.actions;
        result.actions = result.actions.concat(actions);
        return result;
      },
      { actors: {}, actions: [] }
    );
  }

  _randomElement(list) {
    const index = this.rng.randomWeightedIndex(
      list.map(a =>
        typeof a === 'string'
          ? 1
          : (typeof a[1] === 'object' ? a[1].weight : a[1]) || 1
      )
    );
    return list[index];
  }

  async _randomActionCheck(actions, actors) {
    let orderedActions = [...actions];
    for (const index in orderedActions) {
      const action = orderedActions[index];
      if (action.length === 1) {
        orderedActions.splice(index, 1, ...this.rng.shuffle(action[0]));
      } else {
        let selectedActor =
          typeof action[0] === 'object'
            ? this._randomElement(action[0])
            : action[0];
        selectedActor =
          typeof selectedActor === 'object' ? selectedActor[0] : selectedActor;
        const selectedAction = this._randomElement(
          await this._filterActions(
            typeof action[1] === 'object' ? action[1] : [action[1]],
            actors[selectedActor]
          )
        );
        if (selectedAction) {
          orderedActions.splice(index, 1, [selectedActor, selectedAction]);
        } else {
          orderedActions.splice(index, 1);
        }
      }
    }
    return orderedActions;
  }
}
