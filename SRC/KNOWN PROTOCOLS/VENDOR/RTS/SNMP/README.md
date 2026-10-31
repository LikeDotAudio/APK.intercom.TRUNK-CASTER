# RTS / Telex MIB files

The simulator loads every `*.mib` in this folder by the module name inside the file.

The filenames do not match the modules they contain (the set is rotated):
run `python ../SIMULATOR/rts_intercom_sim.py --check-mibs` for the real mapping.
`Telex-Icom-MIB` (the matrix frame's own tables) is missing from the set; add it
here and the parser will pick it up.

What SNMP is and how it is used generically: `../../../SNMP/SNMP.md`.
