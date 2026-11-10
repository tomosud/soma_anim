# -*- coding: utf-8 -*-
"""Check in Maya that the FBX written by src/fbx.js plays the same as the web rig.

    mayapy tools/maya_fbx_check.py samples/sample.fbx samples/sample_bake.json

Imports the FBX into an empty scene and compares the world positions of some joints at every frame
with the positions the web rig computed (bake["check"]).
"""
from __future__ import print_function

import json
import sys

import maya.standalone

maya.standalone.initialize(name="python")
import maya.cmds as cmds  # noqa: E402

fbx, bake_path = sys.argv[1], sys.argv[2]
cmds.loadPlugin("fbxmaya", quiet=True)
cmds.file(new=True, force=True)
cmds.currentUnit(time="ntsc")  # 30 fps, as the file
cmds.file(fbx, i=True, type="FBX", ignoreVersion=True, options="fbx")
with open(bake_path) as f:
    check = json.load(f)["check"]
joints = cmds.ls(type="joint")
worst = (0.0, "", 0)
for f, row in enumerate(check["positions"]):
    cmds.currentTime(f)
    for j, want in zip(check["joints"], row):
        got = cmds.xform(j, q=True, ws=True, t=True)
        d = sum((a - b) ** 2 for a, b in zip(got, want)) ** 0.5
        if d > worst[0]:
            worst = (d, j, f)
print("FBX_CHECK joints %d up %s frames %d worst %.4f cm (%s, frame %d)" % (len(joints), cmds.upAxis(q=True, axis=True), len(check["positions"]), worst[0], worst[1], worst[2]))
maya.standalone.uninitialize()
sys.exit(0 if worst[0] < 0.05 else 1)
