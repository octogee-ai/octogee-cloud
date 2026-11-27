import type { ProjectRecipeId } from "@octogee/shared/types/project";
import viteStaticPackage from "./vite-static/package.json" with { type: "json" };
import viteStaticPackageLock from "./vite-static/package-lock.json" with { type: "json" };
import viteStaticPicomatchArchive from "./vite-static/picomatch-archive.json" with { type: "json" };

export interface PlaybookSeed {
  relPath: string;
  content: string;
}

export interface ProjectRecipeStarterSeed extends PlaybookSeed {
  encoding?: "base64";
}

export interface ProjectPlaybookSeedInput {
  projectName: string;
  projectType: string | null;
  recipe: ProjectRecipeId;
  today: string;
}

export interface ProjectRecipeStarterSeedInput {
  projectSlug: string;
  recipe: ProjectRecipeId;
}

interface TypeDoctrine {
  framing: (projectName: string) => string;
  greatMeans: string;
  recipeFit: Record<ProjectRecipeId, string>;
  firstSlice: string;
  craft: string;
  appServicesTrigger: string;
  decisionAim: string;
  doneLine: string | null;
}

const RECIPE_PUBLISH_CONTRACT: Record<ProjectRecipeId, string> = {
  "static-site": "the `public/` folder deploys as-is, with no build step",
  "vite-static": "`npm run build` produces `dist/`, and `dist/` is what deploys",
  "astro-static": "`npm run build` produces `dist/`, and `dist/` is what deploys",
};

const RECIPE_DECISION_CLAUSE: Record<ProjectRecipeId, string> = {
  "static-site": `A plain public folder of HTML, CSS, and JavaScript ships with no build step
in the way.`,
  "vite-static": `Vite gives us components with a fast dev loop, and its build produces the
dist folder that ships.`,
  "astro-static": `Astro renders content pages to static HTML, and its build produces the dist
folder that ships.`,
};

const GAME: TypeDoctrine = {
  framing: (projectName) => `${projectName} is a game, so the bar is a different bar. Nobody reads the
description. Nobody gives it a fair chance. Someone presses something, and
either it feels good or they leave.`,
  greatMeans: `Great here is not scope and it is not art. It is a stranger picking it up
with no instructions, playing for two minutes, and asking to go again.
Everything else is decoration on top of that one moment.`,
  recipeFit: {
    "static-site": `Plain HTML, CSS, and a canvas is the fastest way to get a loop on screen —
nothing between an idea and pressing a key.`,
    "vite-static": `Vite gives you a real component and asset setup with instant reloads, which
earns its keep the moment the loop has real state to keep track of.`,
    "astro-static": `Astro is built for content pages, so a game inside one is a stretch — fine
while the game is a small piece embedded on a page, worth changing the moment
the game is the page.`,
  },
  firstSlice: `One playable loop: one input, one win-or-lose moment. That is the whole
first slice.

In:

- Something the player controls.
- Something that can go wrong.
- A clear end — you won, you lost, go again.

Out, on purpose:

- Menus, title screens, settings, save slots.
- The art pass. Rectangles are fine. Rectangles that feel good are better.
- Levels two through ten. Level one has to earn them.

If it cannot be played in a browser tab in one sitting, it is not the first
slice yet.`,
  craft: `- **Input feel before graphics.** Movement, timing, and response are the
  game; art is paint on top of them. A cube that feels good beats a sprite
  that does not, every single time.
- **Playtest with a stranger, early.** Hand it over, say nothing, and watch.
  Thirty seconds of someone else's confusion teaches you more than a week of
  your own opinions.
- **Juice is cheap and huge.** A sound, a screen shake, a flash on hit, a
  number that pops. One afternoon of feedback effects does more for a game
  than a week of new features.
- **Fun in two minutes, or cut it.** Small things that are fun get bigger.
  Big things that are not fun stay that way at every size.`,
  appServicesTrigger: `For a game the trigger is a leaderboard, or saved progress that follows a
player from their laptop to their phone. Accounts start there — not at the
first pixel.`,
  decisionAim: "a loop someone can actually play in a browser",
  doneLine: "Someone who isn't you played it — and asked to go again.",
};

const SOCIAL: TypeDoctrine = {
  framing: (projectName) => `${projectName} is a social project: the point is people seeing each other, not
one person looking at a screen. That makes the second person the entire test.
One person alone is just a document.`,
  greatMeans: `Great here is two people, on two machines, changing what the other one sees —
and one of them coming back tomorrow without being asked. Reach, polish, and
features all come after that.`,
  recipeFit: {
    "static-site": `A plain page is enough to prove the shape — a profile and a post someone
else can open — before any framework gets a vote.`,
    "vite-static": `Vite fits the moment the page has state to track: who is signed in, what is
posted, what is visible. For something social that moment tends to arrive on
day one.`,
    "astro-static": `Astro is excellent for the parts people only read, though the genuinely
interactive parts will want a different recipe sooner than you expect.`,
  },
  firstSlice: `One profile and one post another person can see. That is it.

In:

- A person can say who they are.
- A person can put something on the page.
- A different person can open it and see it.

Out, on purpose:

- Feeds, ranking, follows, notifications, direct messages.
- Like counts, badges, streaks — anything that needs a crowd to make sense.
- Sign-up polish. That flow can be ugly while you find out if anyone posts.

Two people and one visible thing between them. Prove that first.`,
  craft: `- **Test with two browsers, side by side.** One normal window, one private
  window, two different people. Anything you have only ever seen from your own
  account is untested.
- **Decide what is visible to whom before you build it.** Write the rule in
  plain words in the decisions log — "posts are public, drafts are only mine" —
  then build to that sentence. Retrofitting privacy is the most expensive
  rewrite there is.
- **Moderation from day one, even if it is one delete button.** Somebody will
  eventually put something on your page that you do not want there. At this
  size the whole answer can be: you can delete anything, and people can delete
  their own.
- **Empty is the hardest screen.** The first person to arrive sees nothing.
  Give them something worth staying for anyway.`,
  appServicesTrigger: `For something social the trigger is real accounts and shared data, and it
arrives fast — usually with the second person. Expect it early. Still do not
build it before the first slice works with made-up people.`,
  decisionAim: "a page two people can both see",
  doneLine: "Two different people did it to each other.",
};

const PLANNER: TypeDoctrine = {
  framing: (projectName) => `${projectName} is a planner: a place to hold things in order — a list, a board,
a schedule. It lives or dies on trust. Lose something once and people stop
putting real plans in it.`,
  greatMeans: `Great here is fast in, nothing lost, honest at a glance. Someone types a real
thing in five seconds, closes the tab, comes back a week later, and it is
exactly where they left it.`,
  recipeFit: {
    "static-site": `One page plus the browser's own storage carries a planner much further than
it sounds like it will, with nothing between you and shipping.`,
    "vite-static": `A planner is state on a screen, which is exactly what Vite and a component
framework are for: lists, forms, and fast keyboard entry.`,
    "astro-static": `Astro is happiest with content that mostly sits still, so it fits a planner
that is more written plan than live tool — change the recipe when the page
becomes an app.`,
  },
  firstSlice: `One list or one board that survives a reload. That is the first slice.

In:

- Add an item with one keystroke and one word.
- See the items in a sensible order.
- Close the tab, come back, everything is still where you left it.

Out, on purpose:

- Multiple boards, projects, or workspaces.
- Drag-and-drop polish, animations, tags, filters, saved views.
- Reminders and notifications. They matter later; they hide the model now.

A list that forgets is worse than paper. Start with the not-forgetting.`,
  craft: `- **The data model is the product.** What is an item, what can it hold, what
  can it belong to. Get those three nouns right and the screens fall out of
  them. Get them wrong and every screen fights you forever.
- **Boring plus fast beats pretty.** If adding an item takes more than a
  keystroke and a word, people stop adding items — and an empty planner is a
  dead planner.
- **Local first, then sync.** Keep it in the browser until someone genuinely
  needs the same list somewhere else. That day is a decision, not an accident.
- **Undo and delete are features.** People only put real plans somewhere they
  believe they can take them back out.`,
  appServicesTrigger: `For a planner the trigger is the same list on two devices, or one list shared
with another person. Until one of those is actually asked for, the browser's
own storage is the right answer.`,
  decisionAim: "a list that stays put and is fast to type into",
  doneLine: "Real plans went in, the tab closed, and they were still there.",
};

const TRIP: TypeDoctrine = {
  framing: (projectName) => `${projectName} is a trip: real people, real dates, real places. This page gets
read one-handed, on a phone, in a taxi, by someone who needs one fact right
now. That reader is the whole design brief.`,
  greatMeans: `Great here is answering where and when in five seconds, on a small screen,
possibly with no signal. Beautiful is nice. Findable is the job.`,
  recipeFit: {
    "static-site": `An itinerary is mostly words, dates, and links — a plain page loads instantly
on bad hotel wifi and prints without a fight.`,
    "vite-static": `Vite is more machinery than an itinerary usually needs, but it earns its
place once the plan has moving parts like day switching or filtering.`,
    "astro-static": `Astro is built for exactly this — content pages rendered to fast static HTML
— so a multi-day itinerary stays quick on a phone.`,
  },
  firstSlice: `One itinerary page that answers where and when, on a phone. That is the first
slice.

In:

- The days, in order, with real dates.
- Where you are each day, with the addresses that matter.
- The times that cannot be missed: flights, check-ins, reservations.

Out, on purpose:

- Maps, budget tracking, packing checklists, weather, currency.
- A photo gallery. Photos come after the facts are right.
- Accounts, and editing by other people.

If someone standing on a curb cannot get the answer, nothing else counts.`,
  craft: `- **Content before chrome.** A plain page with the right addresses beats a
  beautiful page with placeholders. Fill the days in before you style them.
- **Real dates and real places from day one.** "Day 1 — hotel TBD" is a
  to-do, not a plan. Placeholder text hides exactly the questions the trip
  still has open.
- **Assume no signal.** The address you need most is the one you need where
  there are no bars. A page that survives airplane mode, and prints onto one
  sheet, is a page that gets used.
- **Photos earn their place.** One picture of the unmarked door you have to
  find is worth twelve of the view.`,
  appServicesTrigger: `For a trip the trigger is your travel companions editing the plan with you,
not just reading it. Reading is a page. Editing together is an app.`,
  decisionAim: "one itinerary page that loads fast on a phone",
  doneLine: "It answered where-and-when from a phone on the sidewalk.",
};

const RESEARCH: TypeDoctrine = {
  framing: (projectName) => `${projectName} is a research project: the work is making one important decision
well, in writing, with the people it affects. The output is not a website. It
is a decision somebody can still stand behind six months from now.`,
  greatMeans: `Great here is a decision made on time, for reasons anyone can read back, by
people who felt heard on the way. A perfect analysis nobody decided on is a
failure. A clear call with an honest why is the win.`,
  recipeFit: {
    "static-site": `A plain page carries a short brief fine, though this kind of project grows
pages faster than you expect and will want room for them.`,
    "vite-static": `Vite is machinery a written decision rarely needs — worth it only if the
comparison itself becomes something people click through.`,
    "astro-static": `Astro is built for exactly this: pages of writing that render to fast, static
HTML, so the brief opens instantly for everyone you send it to.`,
  },
  firstSlice: `A published one-page brief: the question, the options on the table, and the
date the decision gets made. That is the first slice.

In:

- The question, in one sentence, phrased so it can be answered.
- Who it affects, and who actually decides.
- The options as they stand today, even if the list is rough.
- The decision date.

Out, on purpose:

- Finished analysis. The brief exists to start the argument, not end it.
- A recommendation. That comes after the evidence, not before.
- Design. This is words on a page you can send.

A dated question everyone can see beats a month of quiet reading.`,
  craft: `- **Frame one decision, in writing.** The question, who it affects, and when
  it gets decided. Two decisions in one project means neither gets made.
- **Evidence lands in notes, one note per source or option.** Each note says
  where it came from and what it actually claims. Anything you cannot point
  back to a source is an opinion — fine, as long as you label it as one.
- **Compare the contenders honestly on one page.** The same criteria for
  every option, and the case against your favorite written as carefully as
  the case for it. A comparison that flatters the answer you already had is
  not evidence.
- **Post short dated status reports.** Two paragraphs beat a monthly essay:
  what we learned, what changed, what is still open.
- **The decision is the deliverable.** When it is made, record it in the
  decisions log with its why — in this project the log is the point, not a
  side effect — and publish the one-page summary: the question, the call, the
  why, the date. That link is what everyone it affects gets sent.`,
  appServicesTrigger: `For research the trigger usually never comes. Pages and documents carry this
work. If the decision genuinely needs collected input — a form people fill
in, a vote you have to count — that is the moment to ask, and not before.`,
  decisionAim: "a written decision people can read back",
  doneLine: `The decision is recorded — with the why — and everyone it affects
  has the link.`,
};

const EVENT: TypeDoctrine = {
  framing: (projectName) => `${projectName} is an event: a date, a place, and people deciding whether to
come. Everything in this project exists to answer questions guests would
otherwise ask you one at a time.`,
  greatMeans: `Great here is a guest who knows what it is, when it is, where it is, and why
to come — from one link, without messaging you. Then the day itself runs
without you improvising.`,
  recipeFit: {
    "static-site": `A single plain page carries the what, when, and where fine, though it will
want more room once the schedule and the recap arrive.`,
    "vite-static": `Vite is more than an event page usually needs — worth it only if guests are
doing something on the page rather than reading it.`,
    "astro-static": `Astro is built for pages like these: the event page and the schedule render
to fast, static HTML that opens on a phone at the door.`,
  },
  firstSlice: `The published event page: the date, the place, and one reason to come. A link
you can share on day one. That is the first slice.

In:

- What it is, in a sentence someone can forward to a friend.
- When: the date and the start time, unambiguous.
- Where: the address, or the platform if it is online.
- One honest reason to come.

Out, on purpose:

- The full schedule. The page goes up before the agenda exists.
- Registration, tickets, seating, dietary forms.
- Photos and branding. Being findable is worth more than being pretty.

Publish early, update often. That is the whole method.`,
  craft: `- **The page is the answer to every question you would otherwise repeat.**
  Publish it half-finished and keep updating it. "To be confirmed" on a live
  page beats a perfect page nobody has seen.
- **Write the run of show.** A schedule page with times and what happens in
  each slot: sessions, activities, food, the part where people arrive.
  Guests read it, and so do you at nine in the morning on the day.
- **Keep an organizer checklist.** Venue or platform, invites, reminders,
  day-of roles, and a backup plan for whatever is most likely to go wrong.
  Written down, it stops living in your head at 3am.
- **Draft the guest messages in notes before you need them.** The invite, the
  reminder a few days out, the thank-you after. Writing them early is how you
  find out what the page is still missing.
- **Write the recap while it is fresh.** A short page with what happened, the
  photos worth keeping, and what you would do differently. It is the first
  draft of the next one.`,
  appServicesTrigger: `For an event the trigger is collecting something from guests rather than
telling them something: sign-ups you have to count, payments, seat numbers.
A page and a message thread carry an event a long way before that.`,
  decisionAim: "a shareable page that answers what, when, and where",
  doneLine: "A guest found where-and-when from your link without asking you.",
};

const DEFAULT: TypeDoctrine = {
  framing: (projectName) => `${projectName} is a blank canvas — a place to figure it out. That is a real
kind of project, not a missing answer. Most things start unnamed, and the
first job is finding out what this one actually is.`,
  greatMeans: `Great here is knowing more today than yesterday about what this is and who
it is for. One real person opening a link and telling you something true
beats a month of quiet building.`,
  recipeFit: {
    "static-site": `A plain public folder is the shortest distance between an idea and a link you
can send someone.`,
    "vite-static": `Vite fits when the page has real interaction to keep track of, and gives you
a fast loop while you work out what this is.`,
    "astro-static": `Astro fits when this is mostly pages and words, and it stays fast without you
having to think about it.`,
  },
  firstSlice: `Write what this might become on the Canvas — the README in this repo, which
is this project's front page. That is the first slice.

In:

- What this might be, in your own words, however unfinished.
- Who it might be for. One person, by name, if you have one.
- The next question you need answered.

Out, on purpose:

- Features, settings, accounts, and screens for a thing with no shape yet.
- Anything you would be building because a real product would have it.

When it takes shape, ask your agent to name the type of thing this is — a
game, a social space, a planner, a trip, a research project, an event — and
adopt that type's doctrine here. Then keep going.`,
  craft: `- **Name the kind of thing this is, as soon as you can.** Ask your agent to
  help: game, social space, planner, trip, research, event, tool, shop? Each
  one carries its own hard-won doctrine. Adopt it, write it into this page,
  and keep going.
- **Name the person, not "users".** One human being who will actually open
  the link. Everything else gets easier to decide once they have a name.
- **Cut until one thing works.** Two half-things teach you nothing. One
  finished thing teaches you what to build next.
- **Ship before you are comfortable.** The feedback you are avoiding is the
  feedback you need.`,
  appServicesTrigger: `The trigger is the moment two people need to see the same thing, or something
has to survive somewhere other than the browser it was typed into. Before
that, accounts are a distraction in a nice suit.`,
  decisionAim: "a page one real person can open and react to",
  doneLine: null,
};

const TYPE_DOCTRINE: Record<string, TypeDoctrine> = {
  default: DEFAULT,
  game: GAME,
  social: SOCIAL,
  planner: PLANNER,
  trip: TRIP,
  research: RESEARCH,
  event: EVENT,
};

function doctrineFor(projectType: string | null): TypeDoctrine {
  if (projectType && Object.prototype.hasOwnProperty.call(TYPE_DOCTRINE, projectType)) {
    return TYPE_DOCTRINE[projectType];
  }
  return DEFAULT;
}

function howWeBuild(input: ProjectPlaybookSeedInput, doctrine: TypeDoctrine): string {
  const { projectName, recipe } = input;
  return `# How we build ${projectName}

${doctrine.framing(projectName)}

Your agent reads this before working here. Change it, or ask your agent to,
and the change holds from then on.

## What great looks like here

${doctrine.greatMeans}

## Where we start: the ${recipe} recipe

${projectName} starts on the **${recipe}** recipe.
${doctrine.recipeFit[recipe]}

The recipe is not permanent. Ask your agent to change it — your agent updates
the recipe on the project's platform record, and Preview and Publish both
follow it from then on.

## The first slice we ship

${doctrine.firstSlice}

## The craft

${doctrine.craft}

## The basics

- Small steps that ship. One visible change at a time, finished before the next.
- Show, do not summarize. A link someone can click beats a status update.
- Keep the project playbook about how ${projectName} works. Use the workspace
  Platform Playbook for Octogee platform behavior and limits.
- When something should stick, write it here or in the decisions log.
  Conversations evaporate. The repo does not.

## When this project earns real app services

${doctrine.appServicesTrigger}

Until then, start with local or mock data — a hard-coded list, the browser's
own storage, a file committed to this repo. That is not a shortcut. It is how
you find out whether this ever needs accounts at all.

When the trigger is real, ask your agent for an application-services plan. The
answer should be the smallest Firebase path that does the job — usually
sign-in plus a small database with its access rules written down. Never
Octogee's own platform database. And it lands in the decisions log before
anything gets wired.

## This project's defaults — edit these

- **Who it's for:** _fill in the customer_
- **The smallest real thing we ship first:** _fill it in_
- **Our proof link:** _the URL someone can open_
- **Our rhythm:** _evenings? weekends? sprints? whatever's true_
`;
}

function whatDoneMeans(input: ProjectPlaybookSeedInput, doctrine: TypeDoctrine): string {
  const bar = [
    "- It works for a real person, not just in theory.",
    "- Every change carries a check that proves it — so once something is fixed,\n  it stays fixed.",
    "- Someone has actually seen it run. You count.",
    "- It has a preview or live link where people can reach it.",
    "- It is live when the work matters outside the workspace. Done means shipped.",
  ];
  if (doctrine.doneLine) bar.push(`- ${doctrine.doneLine}`);
  return `# What done means

"Done" is the standard your agent builds to: the bar held on every piece
of work in ${input.projectName}.

${bar.join("\n")}

Tighten this list as you learn. Every line you add here is a mistake that
can't happen twice.
`;
}

function workingWithYourAgent(input: ProjectPlaybookSeedInput): string {
  return `# Working with your agent

This is how the two of you work on ${input.projectName}.

- Talk through what you want while it's fresh. Your agent turns it into a
  plan before any building starts — at your speed, in your words.
- Big ideas go one piece at a time. Your agent will propose the split.
- Disagree out loud. "That's not what I meant" early beats a rebuild later.
- When you decide something that should stick, say **"record a decision"** —
  it lands in this project's decisions log, and your agent honors it from
  then on.
- Stuck or curious? Ask your agent to explain what it's doing and why.
  The answer should always come back in plain language.
`;
}

function shippingOnGcp(input: ProjectPlaybookSeedInput): string {
  const { projectName, recipe } = input;
  return `# Shipping on Octogee and Google Cloud

${projectName} ships through Octogee's managed Google Cloud path unless the
decisions log says otherwise.

This project builds on the **${recipe}** recipe:
${RECIPE_PUBLISH_CONTRACT[recipe]}.

## Defaults

- Merged work is ready to publish. Main is not a storage shelf.
- Every publish opens as a preview, and it goes live only after the owner
  approves it.
- The default public shape is Firebase Hosting on
  octogee-{workspaceSlug}-{projectSlug}.web.app.
- Secrets belong in the Octogee platform, never in the repo, screenshots, or chat.
- If this project needs another GCP target, ask Octo to propose the smallest
  option and record the decision before wiring it.

## Before calling it shipped

- The preview link opens.
- The owner approved the preview.
- The production link opens after approval.
- The changed path is checked by a person.
- The repo has enough context for the next session to continue without guessing.

Use the workspace Platform Playbook for how Octogee provisions workspaces,
deploys projects, and handles platform boundaries. Keep this page about this
project's shipping rules.
`;
}

function decisionsLog(input: ProjectPlaybookSeedInput, doctrine: TypeDoctrine): string {
  const { projectName, recipe, today } = input;
  return `# Decisions — ${projectName}

Why things are the way they are in this project. One entry per decision,
newest first. Say "record a decision" and your agent adds it here — then
honors it every time it works on ${projectName}.

## ${today} — ${projectName} starts on the ${recipe} recipe

Why: what matters first is ${doctrine.decisionAim}.
${RECIPE_DECISION_CLAUSE[recipe]}

Ask your agent to change the recipe when ${projectName} outgrows it — the
platform record is where the recipe lives, and Preview and Publish follow it
from there.

## ${today} — ${projectName} keeps a decisions log

Why: choices made in chat get lost. Choices written here are read by your
agent before every session in this project, forever.
`;
}

export function notesWelcomeSeed(scopeName: string): PlaybookSeed {
  return {
    relPath: "notes/welcome.md",
    content: `# Welcome to notes

This is a note — the scratch layer of ${scopeName}. Half-formed thinking
lives here before it becomes anything official: ideas, open questions,
drafts you want another set of eyes on. Everyone in ${scopeName} sees the
same notes, and so does your agent.

When a note hardens into something real, promote it — ask your agent to
move it into the decisions log or the playbook — and then delete the note.
Notes that go nowhere just get deleted. That's the point of scratch.

Delete this one whenever you're ready.
`,
  };
}

export function projectPlaybookSeeds(input: ProjectPlaybookSeedInput): PlaybookSeed[] {
  const doctrine = doctrineFor(input.projectType);
  return [
    { relPath: "runbook/how-we-build.md", content: howWeBuild(input, doctrine) },
    { relPath: "runbook/what-done-means.md", content: whatDoneMeans(input, doctrine) },
    { relPath: "runbook/working-with-your-agent.md", content: workingWithYourAgent(input) },
    { relPath: "runbook/shipping-on-gcp.md", content: shippingOnGcp(input) },
    { relPath: "DECISIONS.md", content: decisionsLog(input, doctrine) },
  ];
}

const viteStarterPicomatch = viteStaticPackageLock.packages["node_modules/picomatch"];

export function projectRecipeStarterSeeds(input: ProjectRecipeStarterSeedInput): ProjectRecipeStarterSeed[] {
  if (input.recipe !== "vite-static") return [];
  const manifest = { ...viteStaticPackage, name: input.projectSlug };
  const lock = {
    ...viteStaticPackageLock,
    name: input.projectSlug,
    packages: {
      ...viteStaticPackageLock.packages,
      "": {
        ...viteStaticPackageLock.packages[""],
        name: input.projectSlug,
      },
    },
  };
  return [
    { relPath: "package.json", content: `${JSON.stringify(manifest, null, 2)}\n` },
    { relPath: "package-lock.json", content: `${JSON.stringify(lock, null, 2)}\n` },
    { relPath: viteStarterPicomatch.resolved.slice("file:".length), content: viteStaticPicomatchArchive.base64, encoding: "base64" },
  ];
}
