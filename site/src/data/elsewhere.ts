export interface Link {
  name: string;
  note: string;
  href: string;
}

export const elsewhere: Link[] = [
  {
    name: 'FreeTheAI',
    note: 'A free OpenAI-compatible API with 70+ models, one key, no card.',
    href: 'https://freetheai.org',
  },
  {
    name: 'Freebuff',
    note: 'A desktop coding agent that runs the models you already have.',
    href: 'https://freebuff.dev',
  },
  {
    name: 'opendoors.wtf',
    note: 'My security writing: research notes, tooling and post-mortems.',
    href: 'https://opendoors.wtf',
  },
  {
    name: 'vibheksoni.com',
    note: 'Everything else I have built, in one place.',
    href: 'https://vibheksoni.com',
  },
  {
    name: 'GitHub',
    note: 'Source for this tool and every other one.',
    href: 'https://github.com/vibheksoni',
  },
];
