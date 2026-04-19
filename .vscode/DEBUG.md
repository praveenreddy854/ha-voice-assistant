# Debugging Guide

## Simple Attach Debugging (Recommended)

### Setup:

1. **Start the service normally:**

   ```bash
   cd service
   npm run dev
   ```

   ✅ This now includes debugging by default on port 9229

2. **Attach the debugger:**

   - Go to the Debug panel (⇧⌘D)
   - Select **"Attach to Service"** from the dropdown
   - Click the green play button or press F5

3. **Set breakpoints** in your TypeScript files and debug!

### Benefits:

- ✅ Just use `npm run dev` like always - debugging is built-in
- ✅ Service runs on port 3005 (same as always)
- ✅ Debugger listens on port 9229
- ✅ Auto-reconnect on file changes (nodemon restarts)
- ✅ Better control over the process
- ✅ Can restart service without restarting debugger

---

## Alternative Methods:

### Method 1: Attach by Process ID

1. Start service: `npm run dev`
2. Select **"Attach by Process ID"** in the debug dropdown
3. Choose the `node` process running `src/index.ts`

### Method 2: Launch Directly (Simple)

- Select **"Launch Service (Simple)"**
- Press F5
- This launches Node.js directly without npm scripts

---

## Troubleshooting:

**If attach fails:**

- Make sure service is running with `npm run dev`
- Check that port 9229 is not in use: `lsof -i :9229`
- Verify the service is listening for debugger connections

**If breakpoints don't work:**

- Make sure source maps are enabled in tsconfig.json
- Restart both the service and debugger

**To see the debug server is running:**
When you run `npm run dev`, you should see a message like:

```
Debugger listening on ws://0.0.0.0:9229/...
```
