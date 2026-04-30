# Questions Form Debugging Guide

## Problem
Users entering a room are not being shown predefined questions to answer before joining.

## How to Test & Debug

### Step 1: Enable Console Logging
1. Open the app in your browser
2. Press `F12` to open Developer Tools
3. Go to the **Console** tab
4. Look for logs with these emojis: 🎮, 📝, 📤, 🏠, 👥, ➕

### Step 2: Create a Room with Questions
1. Go to **Create Room**
2. **IMPORTANT**: Add at least one pre-game question (minimum 5 characters)
   - Example: "What is your favorite color?"
3. Set other parameters (players, duration, difficulty, etc.)
4. Click **Create Room**
5. **Check Console** for this log:
   ```
   🏠 Room Updated: { id: "ABC123", status: "waiting", questionsCount: 1, questions: [...] }
   ```
   - ✅ If you see `questionsCount: 1`, questions were saved
   - ❌ If you see `questionsCount: 0` or `undefined`, questions weren't saved

### Step 3: Join the Room as a Player
1. Open a **different browser tab or incognito window** (to simulate a different user)
2. Log in as a different user
3. Go to **Join Room**
4. Enter the room code from Step 2
5. Click **Join Room**
6. **Check Console** for these logs in order:
   
   a) **Player Creation Log** (appears immediately):
   ```
   ➕ Creating player with status: { hasQuestions: true, status: "pending" }
   ```
   - ✅ If `status: "pending"` → Questions should appear
   - ❌ If `status: "active"` → No questions form will show (problem!)
   - ❌ If `hasQuestions: false` → Room questions not found (problem!)

   b) **Players Update Log** (in room listener):
   ```
   👥 Players Updated: [{ userId: "...", name: "Player", status: "pending" }]
   ```
   - ✅ Should show `status: "pending"` for your player
   - ❌ If showing `status: "active"` → Wrong status (problem!)

   c) **Lobby State Log** (component render):
   ```
   🎮 Lobby State Debug: { isPending: true, questionsCount: 1, ... }
   ```
   - ✅ If `isPending: true` and `questionsCount: 1` → Form should render
   - ❌ If `isPending: false` → Form won't show (problem!)

   d) **Questions Form Log** (when rendering):
   ```
   📝 Questions Form Debug: { questionsCount: 1, questions: [...] }
   ```
   - ✅ Should show your questions
   - ❌ If `questionsCount: 0` → Questions not loaded (problem!)

### Step 4: Submit Answers (if form appears)
1. If the questions form is visible, enter answers
2. Click **Submit Answers**
3. **Check Console** for:
   ```
   📤 Submitting answers for: { normalizedGameId: "ABC123", userId: "...", answersCount: 1 }
   📋 Current player data: { userId: "...", status: "pending", ... }
   ✅ Player status updated to active
   ```
   - ✅ After submission, form should disappear and player joins
   - ❌ If you see an error, note it down

## Troubleshooting Matrix

| Symptom | Expected Console Log | Likely Issue |
|---------|---------------------|--------------|
| Questions form never appears | `questionsCount: 0` | Room questions not saved to Firestore |
| Questions form never appears | `isPending: false` | Player status not set to pending |
| Form appears but empty | `📝 questionsCount: 0` | Questions not being fetched from room |
| Answers won't submit | Error in `📤` logs | Firebase permissions or player not found |
| Form appears for some but not others | Check each player's logs | Different rooms/players have different states |

## What to Report

When you report the issue, include:
1. **Exact logs** from the Console (copy/paste)
2. **When the issue occurs** (on join? on submit?)
3. **Screenshots** of:
   - The room creation form (show questions)
   - The joining page (does form appear?)
   - Browser console logs
4. **How many rooms/players tested** before issue appeared

## Reset Console View

If logs are cluttered:
1. Right-click Console tab
2. Clear console history
3. Start fresh test

## File Changes Made

Added extensive logging to:
- `interacta-frontend/src/pages/Lobby.js` - Added player state debugging
- `interacta-frontend/src/services/gameRooms.js` - Added function flow debugging

These logs will help identify exactly where the questions form flow is breaking.
