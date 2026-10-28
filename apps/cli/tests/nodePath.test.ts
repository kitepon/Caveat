import { expect, it } from 'vitest';
import { resolveHookNodePath } from '../src/nodePath.js';
it('registers the PATH Node command without an installation or version path', () => { expect(resolveHookNodePath()).toBe('node'); });
