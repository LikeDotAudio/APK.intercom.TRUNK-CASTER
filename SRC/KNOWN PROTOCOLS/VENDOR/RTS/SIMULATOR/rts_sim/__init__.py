"""rts_sim -- the RTS / Telex intercom simulator, one module per part.

rts_intercom_sim.py next to this package is the entry point (same CLI as ever) and re-exports
every name from here, so `import rts_intercom_sim` keeps working.

    env           where the simulator lives; optional tc_protocol / tc_map / numpy
    ber           BER / SNMP wire encoding
    mib           tiny MIB parser
    plan          port plan, world capitals, sub-sites, fixed port allocation
    device        Device: OID store + SNMP agent + console
    audio         AudioEngine: the matrix's series of sockets
    matrix        MatrixDevice (ADAM / Cronus / Zeus-III)
    rvon          RvonDevice (RVON-1 / -8 / -C / -I/O / -16)
    trunk_master  TrunkMasterDevice (TM-2000)
    estate        Estate, spawn_config, world_config
    client        built-in walk / get client and trap listener
"""
