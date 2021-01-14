import { ETH, DAI } from '@makerdao/dai-plugin-mcd';

export default {
  // before and after can be omitted, but remain
  // here as an example
  before: (_, { config }) => {
    config.ilk = config && config.ilk ? config.ilk : 'ETH-A';
    config.collateral =
      config && config.collateral ? config.collateral : ETH(2);
    config.dai = config && config.dai ? config.dai : 100;
    return true;
  },
  operation: (user, { maker, config }) => {
    return maker
      .service('mcd:cdpManager')
      .openLockAndDraw(config.ilk, config.collateral, DAI(config.dai));
  },
  after: () => {},
  category: 'cdp'
};
