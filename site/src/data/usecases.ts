export interface UseCase {
  title: string;
  body: string;
}

export const usecases: UseCase[] = [
  {
    title: 'Looking inside an app',
    body: 'See how a shipped app works without building a whole decompiler first.',
  },
  {
    title: 'Security research',
    body: 'Check a released app for hidden phone-home calls, keys or odd behaviour.',
  },
  {
    title: 'Malware analysis',
    body: 'Take apart a suspicious dropper or loader and see what it actually runs.',
  },
  {
    title: 'Recovering lost code',
    body: 'The project is gone but the executable is still around. Get the logic back.',
  },
  {
    title: 'Learning',
    body: 'See how real apps pack up their code and dependencies.',
  },
  {
    title: 'Challenges and CTFs',
    body: 'Get to the code fast when the clock is running.',
  },
];
