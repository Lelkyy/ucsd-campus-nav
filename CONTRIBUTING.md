# Contributing

## How tickets work

Tickets are tasks for you to do. Pick a ticket that nobody else is working on,
and work on one ticket at a time on your own.

- **To claim a ticket:** write your name next to it on the ticket list.
- **When you're done:** add COMPLETED in capital letters next to it.
- **Don't add new tickets yourself.** If you have an idea, DM Leonid on
  Instagram or talk to him in person.

## Workflow for each ticket

`main` is the shared, working version of the project. Never commit to it
directly; every change goes through a pull request (PR).

**1. Get the latest code**

```bash
git checkout main
git pull
```

**2. Make a branch for your ticket**, named `your-name/short-ticket-name`:

```bash
git checkout -b alex/building-search
```

**3. Do the work and commit as you go**, with messages that say what changed:

```bash
git add .
git commit -m "Add search box for buildings"
```

**4. Push your branch**

```bash
git push -u origin alex/building-search
```

**5. Open a pull request** on GitHub (it shows a "Compare & pull request"
button after you push). Fill in the template, and request a review from
**Lelkyy** (Leonid).

**6. Fix anything from the review** by committing to the same branch and
pushing again; the PR updates automatically.

**7. Leonid merges it.** PRs are squash-merged, so your branch becomes one
commit on `main` and is deleted afterwards. Then mark the ticket COMPLETED.

## If `main` changed while you were working

```bash
git checkout main
git pull
git checkout alex/building-search
git merge main
```

Fix any conflicts, commit, and push.

## Ground rules

- Keep each PR to one ticket.
- Don't commit secrets (API keys, passwords) or large generated files.
- If you're stuck for more than a day, say so; tickets can be split up.
