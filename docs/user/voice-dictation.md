# Voice dictation

Arcwright Code records audio on the device you are using, uploads the clip through your authenticated
connection to the composer's environment, and inserts the returned text into the draft. That
environment uses the custom cloud transcription model saved in OpenWhispr, its running local model,
or a local Whisper service. This applies to both the main and annotation composers.

Your client device does not need OpenWhispr or a local transcription service installed. It needs
microphone access; transcription must be configured on the environment you are accessing. Arcwright
checks that environment before asking you to record. It reuses OpenWhispr's selected custom cloud
endpoint, model, API key, and language automatically. For local transcription, it detects the
desktop bridge and selected downloaded model, with a fallback for existing Whisper services.
If OpenWhispr needs an update or a local model, the message explains which step is needed. The desktop build can also
send configured start and end keybinds to the focused desktop application on Linux.

## One-click setup

Open **Settings** → **General** → **Dictation microphone**, then choose **Set up with agent**. T3
starts a dedicated setup thread in the primary project. The setup agent checks the machine running
T3, configures the local transcription service where possible, verifies microphone access, and
reports any step that still needs your approval.

The setup agent does not modify T3 source code. It may need your approval for package installation,
desktop permissions, or other host-level changes. If you are using a remote T3 environment, the
agent runs on that remote machine. Configure OpenWhispr on each T3 server where you want to dictate;
the microphone stays on the phone or computer running the client.

## Requirements

The desktop preview browser lets any webpage request microphone access. Choose **Allow
microphone** or **Deny** when prompted. Each website address has its own choice saved for that
browser profile; incognito choices last only for the session. Camera access is blocked. Clear
the profile's site data to choose again. Websites still need a secure browser context (HTTPS
or a local development address). This permission is separate from T3's composer dictation settings.

- A connected T3 desktop, web, or PWA client with voice dictation enabled.
- OpenWhispr configured as the same user on the connected T3 server. Select your custom
  OpenAI-compatible cloud transcription provider there; no local model download is needed.
  Its saved API key must be accessible through that user's unlocked OS keyring.
- For local transcription instead, run a current OpenWhispr app with a downloaded local model
  selected. Its authenticated desktop bridge is detected automatically. Older versions without
  that bridge need an update.
- Alternatively, an existing whisper.cpp service on loopback ports 8178–8199, with a ready `/health`
  endpoint and multipart WAV transcription at `/inference`.
- Microphone permission for the T3 desktop app or browser.
- On Linux, `ydotool` plus the user permissions needed to inject the configured start/end keybinds.
  Key injection is unavailable in browser-only or non-Linux clients, but microphone transcription
  uses the connected server there.

## Configure T3

1. In **Settings** → **General** → **Dictation microphone**, click **Detect** and grant microphone
   permission when prompted.
2. Select the microphone to use, or leave **System default** selected.
3. Under **Dictation keybinds**, click **Record shortcut** for Start or End and press the complete
   chord. The recorder captures modifier-only chords such as `Ctrl+Shift`; release the keys to
   save, or press Escape to cancel.
4. Return to the composer and click the microphone button immediately left of attachments. Arcwright
   detects transcription support, then starts recording after permission is granted. Click again
   to stop and transcribe on the connected server. No start/end keybind is needed for transcription.
5. Click the microphone while startup or transcription is pending to cancel. A stalled
   transcription stops after about a minute so you can try again.

OpenWhispr must be configured on the selected conversation's server. Installing it only on the client computer
does not provide transcription to a conversation on another machine. With a WSL server, configure
OpenWhispr or a Whisper service inside that WSL environment; a Windows-only OpenWhispr installation
is not detected across the WSL boundary. Arcwright never copies OpenWhispr's token to the client.
Temporary desktop-bridge recordings are private files removed when the request finishes or is cancelled.

## Reuse your custom cloud model

In OpenWhispr, select your custom cloud transcription provider and save its URL, model, and API key.
Arcwright reads that configuration each time you dictate, so edits apply to the next recording.
The key stays on the server and is used only for the saved transcription endpoint; you do not need
to enter it again in Arcwright. Arcwright does not rewrite OpenWhispr settings or save another copy
of the credential. Cloud audio is sent to your configured provider only when you request transcription.

OpenWhispr can be closed for custom cloud transcription. Keep it running to use its dictionary and
snippets. If the keyring is locked or the saved cloud settings cannot be read, Arcwright reports the
problem instead of silently choosing a different provider. Select local transcription in OpenWhispr
to return to its local model.

## OpenWhispr dictionary and snippets

Arcwright automatically reads saved dictionary words and text snippets from the detected OpenWhispr
app for each transcription. Edits in OpenWhispr apply to the next dictation without an import or an
Arcwright settings change. The dictionary preserves the saved spelling of recognized words and
phrases; speaking a snippet trigger inserts its saved replacement text. Longer triggers take
precedence, and replacement text is inserted literally in one pass.

Custom cloud models and direct Whisper services also receive dictionary words and snippet triggers as bounded recognition
hints. OpenWhispr's desktop file-transcription bridge does not currently accept those hints;
desktop-bridge transcripts use dictionary spelling and snippet expansion after recognition.
This does not guess replacements for differently spelled or misheard words. If Whisper returns
the entire hint list, Arcwright retries once without hints.

The library belongs to OpenWhispr on the conversation's server. Its dictionary and snippet APIs
must be available there; unavailable optional APIs leave ordinary dictation working. Reads are
local and authenticated. Arcwright does not modify the OpenWhispr library or store a separate copy.

## Preview annotations

You can also dictate a preview annotation in the desktop app. Click **Annotate** to capture the
current page into a saved modal, then use its microphone to add your comment. It uses the same
microphone and transcription settings as the main composer. Finish or cancel transcription
before attaching or sending the annotation.

The captured screenshot, element details, marks, and comment stay in the modal when the preview
navigates or reloads. A completed capture also restores after an app reload. **Close**, Escape,
and clicking outside the modal ask you to confirm discarding it; **Keep editing** preserves it.
Use **Attach to draft** or **Send** when you are finished. Sending requires the original thread
to be open; otherwise you can attach the annotation to that thread's draft. Discarding the
annotation also cancels dictation.
