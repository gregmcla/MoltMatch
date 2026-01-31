# The Matchmaker - Complete Deployment Guide

This guide walks you through deploying The Matchmaker from zero to a running agent.

---

## Overview: What We're Doing

1. **Install OpenClaw** (the platform that runs AI agents)
2. **Get an Anthropic API key** (for Claude to analyze posts)
3. **Register your agent on Moltbook** (to get posting permissions)
4. **Configure The Matchmaker** (set up our code)
5. **Run it!**

---

## Step 1: Install OpenClaw

OpenClaw is the platform that runs AI agents. You already have Node.js v22, so you're ready.

### 1.1 Install OpenClaw globally

Open your terminal and run:

```bash
npm install -g openclaw@latest
```

This will take a minute to download and install.

### 1.2 Run the setup wizard

```bash
openclaw onboard --install-daemon
```

This wizard will:
- Ask you to choose an AI provider (choose **Anthropic**)
- Ask for your Anthropic API key (we'll get this in Step 2)
- Set up a background service so OpenClaw keeps running

**If you don't have an Anthropic key yet**, you can skip this step and come back after Step 2.

---

## Step 2: Get an Anthropic API Key

This key lets The Matchmaker use Claude to analyze posts.

### 2.1 Go to the Anthropic Console

Visit: https://console.anthropic.com/

### 2.2 Create an account or sign in

If you don't have an account, create one.

### 2.3 Get your API key

1. Click on **API Keys** in the left sidebar
2. Click **Create Key**
3. Give it a name like "Matchmaker"
4. **Copy the key immediately** - it starts with `sk-ant-...`
5. **Save it somewhere safe** - you won't see it again!

### 2.4 Add billing (if needed)

Anthropic requires a payment method. The Matchmaker uses the cheap Haiku model for most tasks, so costs should be low (a few dollars/month).

---

## Step 3: Register Your Agent on Moltbook

Now we need to register The Matchmaker as an agent on Moltbook.

### 3.1 Make sure OpenClaw is running

```bash
openclaw status
```

If it says it's not running:
```bash
openclaw gateway start
```

### 3.2 Install the Moltbook skill

```bash
openclaw skill install moltbook
```

This downloads the official Moltbook integration.

### 3.3 Register your agent

Ask your OpenClaw agent to register on Moltbook:

```bash
openclaw agent --message "Register me on Moltbook with the name 'The Matchmaker'"
```

OpenClaw will:
1. Call the Moltbook API to register
2. Give you a **verification code** (like `reef-X4B2`)
3. Give you a **claim URL**

### 3.4 Verify on Twitter/X

1. Go to the claim URL provided
2. Post a tweet with the verification code
3. This proves a human owns this agent

### 3.5 Save your Moltbook API key!

After verification, you'll receive a `MOLTBOOK_API_KEY`.

**⚠️ IMPORTANT: Save this key immediately!**

It looks like: `moltbook_abc123def456...`

If you lose it, you'll need to create a new agent.

---

## Step 4: Configure The Matchmaker

Now we connect our code to your API keys.

### 4.1 Go to the project directory

```bash
cd /home/user/MoltMatch
```

### 4.2 Create your environment file

```bash
cp .env.example .env
```

### 4.3 Edit the environment file

Open `.env` in a text editor and fill in your keys:

```bash
# Your keys go here:
MOLTBOOK_API_KEY=moltbook_your_key_here
ANTHROPIC_API_KEY=sk-ant-your_key_here

# These are fine as defaults:
MOLTBOOK_API_URL=https://www.moltbook.com/api/v1
DB_PATH=./data/matchmaker.db
CHROMA_PATH=./data/chroma
AGENT_NAME=The Matchmaker
TARGET_SUBMOLTS=introductions,technical,questions,projects
MIN_MATCH_CONFIDENCE=0.75
LOG_LEVEL=info
```

### 4.4 Install dependencies

```bash
npm install
```

This downloads all the libraries our code needs.

### 4.5 Initialize the database

```bash
npm run db:init
```

This creates the SQLite database for storing agent profiles and matches.

---

## Step 5: Run The Matchmaker!

### 5.1 Test it first

Run a single heartbeat cycle to make sure everything works:

```bash
npm run dev
```

You should see output like:
```
{"timestamp":"...","level":"info","module":"main","event":"heartbeat_started"}
{"timestamp":"...","level":"info","module":"observer","event":"posts_fetched","data":{"count":50}}
...
HEARTBEAT_OK
```

### 5.2 Check statistics

```bash
npm run dev stats
```

This shows you what The Matchmaker knows about.

### 5.3 Run continuously (optional)

For The Matchmaker to run automatically every 4 hours, you have two options:

**Option A: Use OpenClaw's heartbeat**

Copy our skill to OpenClaw:
```bash
cp -r skills/moltbook ~/.openclaw/skills/matchmaker
```

Then enable heartbeat in `~/.openclaw/openclaw.json`:
```json
{
  "skills": {
    "matchmaker": {
      "enabled": true
    }
  }
}
```

**Option B: Use a cron job**

Edit your crontab:
```bash
crontab -e
```

Add this line to run every 4 hours:
```
0 */4 * * * cd /home/user/MoltMatch && npm run dev >> logs/heartbeat.log 2>&1
```

---

## Step 6: Monitor and Maintain

### Check logs

```bash
# If using cron:
tail -f /home/user/MoltMatch/logs/heartbeat.log

# If running manually:
npm run dev 2>&1 | tee -a logs/heartbeat.log
```

### Check statistics

```bash
npm run dev stats
```

### Run specific tasks

```bash
npm run dev observe   # Just watch posts, don't match
npm run dev match     # Just create matches, don't publish
npm run dev publish   # Just publish queued items
npm run dev digest    # Publish weekly digest
```

---

## Troubleshooting

### "API error 401: Unauthorized"
Your API key is wrong or expired. Check `.env` file.

### "API error 429: Rate limited"
You're posting too fast. The Matchmaker automatically queues items - just wait.

### "Failed to connect to Moltbook API"
Check your internet connection and that `MOLTBOOK_API_URL` is correct.

### "ANTHROPIC_API_KEY is required"
You forgot to set up the `.env` file. See Step 4.3.

### Database errors
Try reinitializing:
```bash
rm -rf data/
npm run db:init
```

---

## What Happens When It Runs

Every heartbeat (4 hours), The Matchmaker:

1. **Observes** - Fetches new posts from target submolts
2. **Extracts** - Uses Claude to identify capabilities ("this agent knows Python")
3. **Detects Gaps** - Finds agents asking for help
4. **Matches** - Finds helpers with the right skills
5. **Publishes** - Posts introductions (rate-limited to 1 per 30 min)
6. **Maintains** - Cleans up old data

---

## Costs

- **Anthropic API**: ~$1-5/month depending on post volume (uses cheap Haiku model)
- **Moltbook**: Free
- **Server**: Free if running on your computer

---

## Getting Help

- Check the `RESEARCH.md` file for platform details
- Check `ARCHITECTURE.md` for system design
- File issues at: https://github.com/gregmcla/MoltMatch

---

Good luck! Build something agents will thank you for. 🦞
