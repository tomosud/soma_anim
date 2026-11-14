# -*- coding: utf-8 -*-
"""Check in Maya that a bake plays the same on the real rig as in the web app.

    mayapy tools/maya_check.py <Rig_Manny.ma> samples/sample_bake.json

Opens the rig scene (nothing is saved), imports the bake with maya/soma_anim_import.py and compares the
world positions of some joints at every frame with the positions the web rig computed (bake["check"]).
"""
from __future__ import print_function

import json
import os
import sys

import maya.standalone

maya.standalone.initialize(name="python")
import maya.cmds as cmds  # noqa: E402

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "maya"))
import soma_anim_import  # noqa: E402

scene, bake_path = sys.argv[1], sys.argv[2]
cmds.file(scene, open=True, force=True, prompt=False)
soma_anim_import.load(bake_path, start=0)
with open(bake_path) as f:
    bake = json.load(f)
check = bake["check"]
worst = (0.0, "", 0)
for f, row in enumerate(check["positions"]):
    cmds.currentTime(f)
    for j, want in zip(check["joints"], row):
        got = cmds.xform(j, q=True, ws=True, t=True)
        d = sum((a - b) ** 2 for a, b in zip(got, want)) ** 0.5
        if d > worst[0]:
            worst = (d, j, f)
print("MAYA_CHECK frames %d joints %d worst %.4f cm (%s, frame %d)" % (len(check["positions"]), len(check["joints"]), worst[0], worst[1], worst[2]))
maya.standalone.uninitialize()
sys.exit(0 if worst[0] < 0.05 else 1)
