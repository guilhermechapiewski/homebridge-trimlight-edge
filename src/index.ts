import type { API } from 'homebridge';

import { TrimlightPlatform } from './platform';
import { PLATFORM_NAME } from './settings';

export = (api: API): void => {
  api.registerPlatform(PLATFORM_NAME, TrimlightPlatform);
};
