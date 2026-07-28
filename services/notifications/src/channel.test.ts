import { describe, expect, it, vi } from 'vitest';
import { logChannel, neverThrows } from './channel';

describe('neverThrows', () => {
  it('swallows a delivery failure', async () => {
    // A mail outage must not fail a request whose real work already committed.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exploding = {
      name: 'boom',
      send: async () => {
        throw new Error('SMTP unreachable');
      },
    };
    await expect(
      neverThrows(exploding).send({ to: 'a@b.c', subject: 's', text: 't' }),
    ).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('passes a successful delivery through', async () => {
    const sent: string[] = [];
    const channel = neverThrows({
      name: 'ok',
      send: async (message) => {
        sent.push(message.to);
      },
    });
    await channel.send({ to: 'a@b.c', subject: 's', text: 't' });
    expect(sent).toEqual(['a@b.c']);
  });
});

describe('logChannel', () => {
  it('prints instead of delivering, and never throws', async () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(
      logChannel().send({ to: 'a@b.c', subject: 's', text: 't' }),
    ).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
