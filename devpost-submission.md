DEVPOST SUBMISSION: Boardroom Crisis Simulator
==============================================

------------------------------------------------------------
FIELD: About the project  (paste everything between the lines)
------------------------------------------------------------

## Inspiration
When a real crisis hits (a ransomware attack, a service outage, a leader who can't be reached), executives rarely get to practise beforehand. Tabletop exercises exist, but they need a trained facilitator, a room full of people and hours of preparation, so most teams run them once a year at best. We wanted a crisis drill a team could start in a minute: a facilitator that briefs you, advisers you can question and a coach who pushes back on your reasoning, all in a boardroom you can actually sit in.

## What it does
**Boardroom Crisis Simulator** is a multiplayer crisis exercise for **3 to 10 players**. A host opens a room, invites the team with a link and assigns roles (one CEO, plus technology, communications and operations leads). Everyone plays the same incident; our first scenario is a community services agency facing an appointment system outage while its executive director is unreachable.

- **Spoken AI briefing:** an AI facilitator writes the situation from the scenario's public documents and reads it aloud. The incident brief PDF is loaded for everyone automatically.
- **3D boardroom:** every player gets a seated, animated character around a shared table. The camera follows whoever is speaking, and the table's hub glows when an AI voice talks.
- **Open floor discussion:** no turn order and no timers. Whoever speaks takes the floor, by microphone, by chat, or with **AI reply**, which drafts a first person answer for your role and speaks it in your voice.
- **Expert panel:** AI advisers (technical, legal, communications) weigh in with their own voices.
- **Round 1, individual decisions:** each player privately commits what they would do.
- **Round 2, private coaching:** an AI crisis coach questions each player one to one about their decision. Players answer by voice dictation, chat or AI reply.
- **Round 3, assessment:** a scored multiple choice check on what the team learned.
- **Live transcript and captions** of every voice, plus an end of game summary and feedback.
- **Judge demo mode:** one person plays the CEO while automated board members fill the other seats, so the whole game can be tried solo.

## How we built it
- **Frontend:** React 19, TypeScript and Vite. The 3D boardroom uses three.js with the WebGPU renderer (WebGL2 fallback), rigged characters sharing one skeleton with Mixamo animations, and models fetched in parallel while players are still in the lobby.
- **Backend:** FastAPI (Python) is the single authority for rooms, roles, turns, presence and the game's state machine. Every command is idempotent, so a retried click never acts twice.
- **AI text:** Gemini on Google Vertex AI writes the briefing, the expert takes, the coaching questions, the AI replies and the assessment, all grounded in the scenario documents.
- **Voice:** ElevenLabs text to speech, streamed into the browser with MediaSource so playback starts on the first audio chunk. ElevenLabs Scribe transcribes player dictation on the server, with the browser's own speech recognition as a live preview.
- **Deployment:** Docker images (nginx serving the built frontend, uvicorn running the API) on a Vultr server managed with Coolify, with HTTPS on a DuckDNS domain. We used Tailscale Funnel for remote playtests during development.

## Challenges we ran into
- **Latency is the whole experience.** A silent pause after the host presses Start feels broken. We found that Gemini's thinking tokens were eating the output budget and cutting answers off, so we reserved headroom for reasoning and salvaged complete sentences. We also found that about 1 in 8 requests hung until a 30 second timeout. We now send a backup request if the first one stalls and keep whichever answers first, start writing the briefing the moment the game starts, and stream the speech. The opening went from about 5.5 s to about 2.6 s before the first word, and the expert panel from 19.8 s to 3.7 s.
- **Voices that keep talking.** Ending a call has to stop every clip, stream and background poll in every window. We built a single hang up path that silences all media and blocks new playback.
- **Dictation across browsers.** Browser speech recognition is unreliable, so we record the microphone, show a live level meter and transcribe on the server.
- **Multiplayer rules.** A real room has to answer awkward questions: what happens when the CEO leaves (the game ends for everyone), when anyone else leaves (one fewer player), and when two people try to speak at once (the first one holds the floor).

## Accomplishments that we're proud of
- A full game loop, from lobby to briefing, discussion, decisions, coaching and assessment, with real voices end to end.
- A 3D boardroom that seats up to ten players and still loads quickly.
- A solo judge mode that makes the multiplayer experience testable by one person.

## What we learned
Perceived speed matters more than raw model quality: streaming, prewarming and parallel backup requests mattered more than any prompt tweak. We also learned how much product thinking goes into multiplayer edge cases that never show up in a single player demo.

## What's next
- More scenarios beyond the first one.
- Durable rooms that survive a server restart.
- Facilitator dashboards for training teams.
- After action reports built from the transcript.

------------------------------------------------------------
FIELD: Built with  (up to 25 tags; add them one at a time)
------------------------------------------------------------

React
TypeScript
Vite
three.js
WebGPU
Python
FastAPI
Uvicorn
Google Vertex AI
Gemini
ElevenLabs
ElevenLabs Scribe
Web Audio API
MediaSource API
MediaRecorder API
Mixamo
Docker
nginx
Coolify
Vultr
DuckDNS
Tailscale
Node.js
GitHub

------------------------------------------------------------
FIELD: "Try it out" links
------------------------------------------------------------

https://boardroomcrisis.duckdns.org
https://github.com/jeefwashere/BoardroomCrisisSimulator

------------------------------------------------------------
FIELD: Image gallery  (JPG/PNG/GIF, 5 MB max, 3:2 ratio, up to 15)
------------------------------------------------------------

Suggested shots, in this order:
1. The 3D boardroom full of players, with name tags and the AI facilitator speaking.
2. The lobby: room code, Invite button, T01 brief and "n of 10 players".
3. The opening briefing with the live transcript open.
4. The open floor, with one player holding the floor.
5. Round 2 coaching: the coach's question card and dictation.
6. The Round 3 assessment question.
7. The end of game summary.
8. The home screen with Host, Join and Judge demo.

------------------------------------------------------------
FIELD: Video demo link  (YouTube or Vimeo URL)
------------------------------------------------------------

<paste your YouTube or Vimeo link here>
Tip: a 2 to 3 minute walkthrough in the same order as the gallery.

------------------------------------------------------------
CHECK BEFORE SUBMITTING
------------------------------------------------------------

- The live site runs the old build until someone presses Deploy in Coolify.
- Confirm the GitHub repo is public.
- Drop Tailscale from Built with if you'd rather not mention the dev tunnel.
- Add any teammate tools not listed above, such as the GPU hosted fallback model, if it's used in the product.
