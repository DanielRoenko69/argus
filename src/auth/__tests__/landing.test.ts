import { landingFor } from '../landing.js';

describe('landingFor', () => {
  it('routes chat_user to /chat', () => {
    expect(landingFor('chat_user')).toBe('/chat');
  });

  it('routes viewer to /home', () => {
    expect(landingFor('viewer')).toBe('/home');
  });

  it('routes platform_admin to /home', () => {
    expect(landingFor('platform_admin')).toBe('/home');
  });

  it('routes undefined to /home', () => {
    expect(landingFor(undefined)).toBe('/home');
  });
});
