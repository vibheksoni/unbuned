export interface Step {
  title: string;
  body: string;
}

export const steps: Step[] = [
  {
    title: 'Work out what kind of file it is',
    body: 'Windows, Mac or Linux. The Mac build can hold several versions in one file, so unbuned picks the right one.',
  },
  {
    title: 'Find the part Bun uses',
    body: 'Every Bun app keeps its code in a section called .bun. unbuned reads the section table to find it.',
  },
  {
    title: 'Start at the first file',
    body: 'The code begins with a // @bun marker. Starting from a known spot means unbuned can only ever cut too little, never too much.',
  },
  {
    title: 'Walk through each file',
    body: 'Bun separates the compiled files with a marker and a null byte. unbuned counts them all and notes where each one starts.',
  },
  {
    title: 'Find where the code stops',
    body: 'It counts the bytes that are not text, then checks for the comments Bun writes at the end of the code.',
  },
  {
    title: 'Read the list of packed files',
    body: 'Bun stores a list of every file it put in the app, with names, sources and assets. That is where the real names come from.',
  },
  {
    title: 'Write the file out',
    body: 'The JavaScript is saved exactly as it was, with no re-encoding, and the file is never loaded fully into memory.',
  },
];
