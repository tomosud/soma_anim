# -*- coding: utf-8 -*-
"""Bring a SOMA Anim bake (soma_anim_bake.json, "Maya 用に書き出し") onto Rig_Manny in Maya.

    import soma_anim_import
    soma_anim_import.load(r"C:/path/soma_anim_bake.json")              # every frame
    soma_anim_import.load(r"C:/path/soma_anim_bake.json", keys_only=True)  # only the key poses

The file holds one value per control channel per frame.  The values are offsets from the rest
value of the channel; every control of Rig_Manny rests at 0, so they are set as they are.
"""
from __future__ import absolute_import, division, print_function

import json

import maya.cmds as cmds


def load(path, namespace="", start=None, keys_only=False, set_range=True):
    with open(path, "r") as f:
        data = json.load(f)
    if data.get("format") != "soma_anim_bake":
        raise RuntimeError("not a soma_anim bake file: %s" % path)
    offset = (cmds.currentTime(q=True) if start is None else start) - data["start"]
    plugs = []
    missing = set()
    for ch in data["channels"]:
        ctl, attr = ch.rsplit(".", 1)
        node = namespace + ctl
        if not cmds.objExists(node):
            missing.add(ctl)
            plugs.append(None)
            continue
        plug = "%s.%s" % (node, attr)
        plugs.append(plug if cmds.getAttr(plug, settable=True) or cmds.getAttr(plug, keyable=True) else None)
    frames = data["frames"]
    wanted = set(data.get("keys", [])) if keys_only else None
    for i, plug in enumerate(plugs):
        if plug is None:
            continue
        for f, values in enumerate(frames):
            if wanted is not None and f not in wanted:
                continue
            cmds.setKeyframe(plug, time=f + offset, value=values[i])
    if set_range:
        cmds.playbackOptions(min=offset + data["start"], max=offset + data["end"])
    if missing:
        cmds.warning("soma_anim: controls not found: %s" % ", ".join(sorted(missing)))
    print("soma_anim: %d frames, %d channels" % (len(frames), len([p for p in plugs if p])))
    return len(frames)
