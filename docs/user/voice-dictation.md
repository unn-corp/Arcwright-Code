# Voice dictation

Arcwright Code records audio on the device you are using, uploads the clip through your authenticated
connection to the composer's environment, and inserts the returned text into the draft. That
environment processes the clip with its running OpenWhispr app or local Whisper service, just as it does for a
recording made on that computer. This applies to both the main and annotation composers.

Your client device does not need OpenWhispr or a local transcription service installed. It needs
microphone access; transcription must be configured on the environment you are accessing. Arcwright
checks that environment before asking you to record. It detects OpenWhispr's desktop bridge and
selected downloaded local model automatically, with a fallback for existing Whisper services.
If OpenWhispr needs an update or a local model, the message explains which step is needed. The desktop build can also
send configured start and end keybinds to the focused desktop application on Linux.

## One-click setup

Open **Settings** → **General** → **Dictation microphone**, then choose **Set up with agent**. T3
starts a dedicated setup thread in the primary project. The setup agent checks the machine running
T3, configures the local transcription service where possible, verifies microphone access, and
reports any step that still needs your approval.

The setup agent does not modify T3 source code. It may need your approval for package installation,
desktop permissions, or other host-level changes. If you are using a remote T3 environment, the
agent runs on that remote machine. Run OpenWhispr on each T3 server where you want to dictate;
the microphone stays on the phone or computer running the client.

## Requirements

The desktop preview browser lets any webpage request microphone access. Choose **Allow
microphone** or **Deny** when prompted. Each website address has its own choice saved for that
browser profile; incognito choices last only for the session. Camera access is blocked. Clear
the profile's site data to choose again. Websites still need a secure browser context (HTTPS
or a local development address). This permission is separate from T3's composer dictation settings.

- A connected T3 desktop, web, or PWA client with voice dictation enabled.
- A current OpenWhispr desktop app running as the same user on the connected T3 server, with a
  downloaded local transcription model selected. Its authenticated desktop bridge is detected
  automatically. Older OpenWhispr versions without the transcription bridge need an update;
  cloud-only dictation in OpenWhispr does not supply a local transcription model.
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

OpenWhispr must run on the selected conversation's server. Installing it only on the client computer
does not provide transcription to a conversation on another machine. With a WSL server, run
OpenWhispr or a Whisper service inside that WSL environment; a Windows-only OpenWhispr installation
is not detected across the WSL boundary. Arcwright never copies OpenWhispr's token to the client.
Temporary desktop-bridge recordings are private files removed when the request finishes or is cancelled.

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
