let chatsWaitingOnCommand = 0;

export function registerForegroundCommand(): () => void {
  chatsWaitingOnCommand += 1;
  return () => {
    chatsWaitingOnCommand -= 1;
  };
}

export function isForegroundCommandRunning(): boolean {
  return chatsWaitingOnCommand > 0;
}
