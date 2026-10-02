const { breakIdle } = require('../../src/services/email/EmailWatcher');

describe('IMAP idle break', () => {
  it('sends DONE only while the connection is idling', () => {
    const preCheck = jest.fn(() => Promise.resolve());
    breakIdle({ idling: false, preCheck });
    expect(preCheck).not.toHaveBeenCalled();
    breakIdle({ idling: true, preCheck });
    expect(preCheck).toHaveBeenCalledTimes(1);
    breakIdle(null);
    breakIdle({ idling: true });
  });

  it('ignores a rejected break', async () => {
    const preCheck = jest.fn(() => Promise.reject(new Error('closed')));
    breakIdle({ idling: true, preCheck });
    await new Promise((resolve) => setImmediate(resolve));
    expect(preCheck).toHaveBeenCalledTimes(1);
  });
});
