import { ETH, DAI } from '@makerdao/dai-plugin-mcd';

export default {
  precondition: async (user, { maker, config }) => {
    config.collateral = config.collateral || ETH(1);
    return (await maker
      .service('token')
      .getToken(config.collateral.symbol)
      .balance()).gte(config.collateral);
  },
  before: (_, { config }) => {
    config.ilk = config.ilk ? config.ilk : 'ETH-A';
    config.collateral = config.collateral ? config.collateral : ETH(1);
    return true;
  },
  operation: async (user, { maker, config }) => {
    const manager = maker.service('mcd:cdpManager');
    const managerAddress = manager
      .get('smartContract')
      .getContractAddress('CDP_MANAGER');

    //open CDP
    const cdp = await maker
      .service('mcd:cdpManager')
      .openLockAndDraw(config.ilk, config.collateral, DAI(20));
    cdp.reset();
    cdp.type.reset();
    await cdp.prefetch();

    //draw maximum amount of collateral using frob directly (skipping drip())
    const ilkInfo = await cdp.type.ilkInfo();
    const amount = cdp.isSafe
      ? cdp.daiAvailable.shiftedBy(27).div(ilkInfo.rate)
      : DAI(0);

    const method = 'frob';
    const args = [
      managerAddress,
      cdp.id,
      ETH(0).toFixed('wei'),
      amount.toFixed('wei'),
      {
        dsProxy: true,
        value: 0
      }
    ].filter(x => x);

    await manager.proxyActions[method](...args);
    const urn = await cdp.getUrn();

    return {
      message: 'cdp unsafe',
      cpd_id: cdp.id,
      cdp_ilk: cdp.ilk,
      cdp_urn: urn
    };
  },
  after: () => {},
  category: 'cdp'
};
