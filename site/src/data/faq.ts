export interface Faq {
  question: string;
  answer: string;
}

export const faqs: Faq[] = [
  {
    question: 'What does unbuned actually do?',
    answer:
      'It takes the JavaScript out of an app that was built with Bun. It finds the .bun part of the file, works out where the code stops and the rest of the data begins, and saves the code as a normal .js file you can open in any editor.',
  },
  {
    question: 'Do I need to install anything?',
    answer:
      'No. unbuned is one Python file that uses the standard library. If you have Python 3.6 or newer, you are ready to go. There is nothing to install.',
  },
  {
    question: 'What kinds of files does it work on?',
    answer:
      'Windows .exe files, Mac apps, and Linux binaries built with Bun. If a file does not have the usual section table, unbuned searches the whole file for Bun markers instead.',
  },
  {
    question: 'Can it get the original source files back?',
    answer:
      'When the app shipped source maps, yes. unbuned unpacks them and writes the original files into a folder that keeps their real names. Claude Code and Factory Droid both ship source maps, so thousands of files come back.',
  },
  {
    question: 'How does it know the real file names?',
    answer:
      'Bun writes a list of every file it packed into the app before the code itself. unbuned reads that list, so files come back with the names they had on the developer machine instead of made-up ones.',
  },
  {
    question: 'Am I allowed to use it?',
    answer:
      'It is meant for reverse engineering, security research, malware analysis, learning and recovering your own code. Please respect the licence of the software you look at, any contract you agreed to, and the law where you live.',
  },
];
