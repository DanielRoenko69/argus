import { describe, it, expect } from '@jest/globals';
import { shouldServeChatSpa } from '../agents/chat/chatSpaServe.js';
describe('shouldServeChatSpa', () => {
  it('off by default', () => { expect(shouldServeChatSpa(false, {})).toBe(false); });
  it('on when flag set and no ?classic', () => { expect(shouldServeChatSpa(true, {})).toBe(true); });
  it('classic=1 override wins', () => { expect(shouldServeChatSpa(true, { classic: '1' })).toBe(false); });
  it('classic=true override wins', () => { expect(shouldServeChatSpa(true, { classic: 'true' })).toBe(false); });
  it('flag off ignores classic', () => { expect(shouldServeChatSpa(false, { classic: '1' })).toBe(false); });
});
