# Ward-Beck Systems - Crosspoint Line

**Type:** Plain-text crosspoint control. One comma-separated line per switch.

## How Ward-Beck uses it
A very simple routing-switcher protocol: every crosspoint is one line, readable by a person and
by a machine. Trunk-Caster adopts it as the unifying words between every vendor and protocol.

## Hardware / software
- Any serial or TCP text channel
- Any log file

## Connecting to the device
- Send one line per crosspoint change, newline terminated
- Fields: SITE,FRAME,INPUT,INPUT_NAME,CLOSE/OPEN,OUTPUT_NAME,OUTPUT,FRAME,SITE
- Left side is where the signal enters, right side is where it leaves; each side names its own frame and site
- Same frame on both sides: a crosspoint inside that frame. Different frames or sites: an end-to-end connection

## Talking to the panel
- INPUT_NAME and OUTPUT_NAME carry the people on the ports, so a panel label is the name of whoever called through it
- CLOSE makes the connection. OPEN expresses that it is no longer there

## Check-in
- INPUT = CHECKIN marks a periodic check-in: SITE,FRAME,CHECKIN,<time>,CLOSE|OPEN,<n> crosspoints,<n>,FRAME,SITE
- CLOSE when the frame has crosspoints closed, OPEN when it is idle
- Followed by one CLOSE line per closed crosspoint, so a listener can rebuild the frame from the last check-in

## Trunking notes
This is the lingua franca of Trunk-Caster: deltas, check-ins and end-to-end connections across any
protocol are all written in it (TRUNK-CROSS POINTS/wardbeck.log and checkin.wb).
