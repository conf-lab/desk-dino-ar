# 정지 모델 다섯 개에 뼈대와 동작(idle, walk, run, roar)을 넣어 책상 크기(최대 30cm) GLB로 내보낸다.
# 사용: blender -b --factory-startup --python-exit-code 1 -P scripts/rig_dinos.py -- <정지 모델 폴더> <출력 폴더> [미리보기 폴더] [이름,...]
# 좌표는 실제 크기 미터(앞 -Y, 위 +Z, 동물의 왼쪽 +X)로 잰 값이다. 제자리 동작이며 이동은 앱이 speed에 맞춰 한다.
import json
import math
import os
import sys

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector

TAU = math.tau
FPS = 24
DESK = 0.3


def smooth(x):
    x = max(0.0, min(1.0, x))
    return x * x * (3 - 2 * x)


def mix(a, b, t):
    return a + (b - a) * t


def chain(bones, names, pts, parent):
    for n, (a, b) in zip(names, zip(pts, pts[1:])):
        bones[n] = (a, b, parent, True)
        parent = n


def skeleton(sp):
    """이름 → (시작, 끝, 부모, 변형 여부)"""
    b = {'root': ((0, 0, 0), (0, -0.1 * sp['length'], 0), None, False)}
    ax = lambda pts: [(0, y, z) for y, z in pts]
    chain(b, ['pelvis', 'spine', 'chest'][:len(sp['trunk']) - 1], ax(sp['trunk']), 'root')
    last = ['pelvis', 'spine', 'chest'][len(sp['trunk']) - 2]
    necks = [f'neck{i}' for i in range(len(sp['neck']) - 1)]
    chain(b, necks, ax(sp['neck']), last)
    chain(b, ['head'], ax(sp['head']), necks[-1])
    b['jaw'] = ((0, *sp['jaw']['hinge']), (0, *sp['jaw']['tip']), 'head', False)
    if sp.get('tail'):
        chain(b, [f'tail{i}' for i in range(len(sp['tail']) - 1)], ax(sp['tail']), 'pelvis')
    m = lambda p, s: (p[0] * s, p[1], p[2])
    for s, n in ((1, 'L'), (-1, 'R')):
        for leg, pts in sp.get('legs', {}).items():
            q = [m(p, s) for p in pts]
            top = 'pelvis' if leg == 'hind' else last
            chain(b, [f'{leg}{k}.{n}' for k in ('Upper', 'Lower', 'Foot', 'Toe')[:len(q) - 1]], q, top)
            b[f'{leg}Ik.{n}'] = (q[2], q[3], None, False)
        for part, (pts, parent) in sp.get('extra', {}).items():
            q = [m(p, s) for p in pts]
            chain(b, [f'{part}{i}.{n}' for i in range(len(q) - 1)], q, parent)
    return b


SPECIES = {
    'trex': dict(
        length=12, trunk=[(0.3, 2.75), (-1.0, 2.75), (-2.1, 2.8), (-3.1, 2.95)],
        neck=[(-3.1, 2.95), (-3.95, 3.65)], head=[(-3.95, 3.65), (-5.9, 3.6)],
        jaw=dict(hinge=(-4.3, 3.6), tip=(-5.85, 3.25), closed=0, open=27, fade=0.5, floor=2.6,
                 cut=[(-4.40, 3.71), (-4.70, 3.64), (-5.05, 3.555), (-5.45, 3.40), (-5.75, 3.385), (-6.05, 3.45)]),
        tail=[(0.3, 2.75), (1.0, 2.68), (1.8, 2.63), (2.6, 2.6), (3.4, 2.59), (4.2, 2.58), (5.0, 2.53), (5.95, 2.36)],
        legs={'hind': [(0.62, -0.8, 2.75), (0.85, -1.4, 1.9), (0.87, -0.95, 1.0), (0.95, -1.2, 0.2), (1.05, -1.9, 0.12)]},
        extra={'arm': ([(0.5, -3.15, 2.6), (0.6, -3.15, 2.28), (0.42, -3.3, 1.92)], 'chest')},
        walk=dict(stride=3.3, speed=2.9, duty=0.62, crouch=0.17, lift=0.35, bob=0.05, roll=34),
        run=dict(stride=5.4, speed=8.6, duty=0.38, crouch=0.22, lift=0.75, bob=0.13, roll=34),
        roar=4.3, look=11),
    'triceratops': dict(
        length=8, trunk=[(0.5, 1.95), (-0.2, 2.05), (-0.95, 2.0), (-1.7, 1.85)],
        neck=[(-1.7, 1.85), (-2.4, 1.85)], head=[(-2.4, 1.85), (-3.9, 1.75)],
        jaw=dict(hinge=(-3.1, 1.64), tip=(-3.85, 1.42), line=(-3.9, 1.51), closed=9, open=14, fade=0.3, floor=1.2),
        tail=[(0.5, 1.95), (1.2, 1.9), (1.9, 1.84), (2.6, 1.79), (3.3, 1.77), (3.95, 1.76)],
        legs={'hind': [(0.5, 0.3, 1.75), (0.6, 0.1, 1.0), (0.58, 0.42, 0.34), (0.58, 0.2, 0.06)],
              'fore': [(0.55, -1.75, 1.65), (0.68, -1.58, 1.02), (0.62, -1.86, 0.36), (0.62, -2.0, 0.06)]},
        rigid=lambda p: 1.0 if p.z > 2.65 and p.y < -1.7 else smooth((p.z - 1.75) / 0.2) if p.y < -1.83 - (3.46 - p.z) * 0.22 else smooth((-2.75 - p.y) / 0.3),
        walk=dict(stride=1.8, speed=1.5, duty=0.68, crouch=0.13, lift=0.16, bob=0.015, roll=18),
        run=dict(stride=2.7, speed=4.6, duty=0.46, crouch=0.16, lift=0.30, bob=0.06, roll=24),
        roar=2.8, look=8),
    'stegosaurus': dict(
        length=7, trunk=[(0.3, 1.75), (-0.4, 1.75), (-1.0, 1.62), (-1.65, 1.45)],
        neck=[(-1.65, 1.45), (-2.2, 1.47), (-2.8, 1.5)], head=[(-2.8, 1.5), (-3.45, 1.42)],
        jaw=dict(hinge=(-3.02, 1.42), tip=(-3.4, 1.33), line=(-3.46, 1.36), closed=3, open=9, fade=0.14, floor=1.2),
        tail=[(0.3, 1.75), (1.0, 1.6), (1.7, 1.53), (2.4, 1.5), (2.95, 1.5), (3.45, 1.52)],
        legs={'hind': [(0.38, -0.08, 1.65), (0.46, -0.28, 1.0), (0.44, 0.0, 0.34), (0.44, -0.18, 0.05)],
              'fore': [(0.36, -1.68, 1.25), (0.42, -1.5, 0.82), (0.36, -1.74, 0.3), (0.35, -1.85, 0.05)]},
        walk=dict(stride=1.5, speed=1.2, duty=0.68, crouch=0.10, lift=0.14, bob=0.012, roll=18),
        run=dict(stride=2.0, speed=2.8, duty=0.52, crouch=0.13, lift=0.22, bob=0.035, roll=22),
        roar=2.7, look=12),
    'brachiosaurus': dict(
        length=22, trunk=[(-0.9, 4.2), (-2.2, 4.5), (-3.9, 4.95), (-5.8, 5.4)],
        neck=[(-5.8, 5.4), (-7.3, 6.05), (-8.5, 7.5), (-9.6, 8.75), (-10.2, 8.95)], head=[(-10.2, 8.95), (-10.95, 8.75)],
        jaw=dict(hinge=(-10.33, 8.74), tip=(-10.9, 8.5), line=(-10.95, 8.6), closed=13, open=10, fade=0.16, floor=8.25),
        tail=[(-0.9, 4.2), (1.0, 4.0), (2.9, 3.8), (4.8, 3.75), (6.7, 3.85), (8.6, 4.0), (10.9, 4.0)],
        legs={'hind': [(0.75, -1.7, 3.6), (0.9, -1.98, 2.1), (0.88, -1.42, 0.75), (0.88, -1.8, 0.1)],
              'fore': [(0.75, -6.2, 4.5), (0.85, -5.95, 2.6), (0.75, -6.28, 0.85), (0.75, -6.45, 0.1)]},
        walk=dict(stride=3.4, speed=2.1, duty=0.70, crouch=0.22, lift=0.35, bob=0.03, roll=16),
        run=dict(stride=4.6, speed=4.2, duty=0.58, crouch=0.30, lift=0.5, bob=0.06, roll=20),
        roar=5.0, look=7),
    'pteranodon': dict(
        length=6, trunk=[(0.95, 0.33), (0.45, 0.47), (0.05, 0.62)],
        neck=[(0.05, 0.62), (-0.2, 0.68)], head=[(-0.2, 0.68), (-1.0, 0.45)],
        jaw=dict(hinge=(-0.27, 0.66), tip=(-1.8, 0.08), line=(-1.84, 0.09), closed=3, open=13, fade=0.25, floor=-1),
        extra={'wing': ([(0.2, 0.28, 0.62), (0.8, 0.22, 0.7), (1.42, 0.1, 0.79), (2.2, 0.15, 0.72), (3.0, 0.25, 0.58)], 'spine'),
               'leg': ([(0.12, 0.95, 0.32), (0.2, 1.3, 0.18), (0.26, 1.58, 0.06)], 'pelvis')},
        rigid=lambda p: max(smooth((-0.22 - p.y) / 0.15), smooth((p.z - 0.86) / 0.08)) if abs(p.x) < 0.14 else 0.0,
        fly=True, roar=2.6, look=6),
}


# ---------- 메시 ----------
def load(path):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=path)
    mesh = next(o for o in bpy.data.objects if o.type == 'MESH')
    world = mesh.matrix_world.copy()
    mesh.parent = None
    mesh.data.transform(world)
    mesh.matrix_world.identity()
    for o in [o for o in bpy.data.objects if o is not mesh]:
        bpy.data.objects.remove(o)
    bm = bmesh.new()
    bm.from_mesh(mesh.data)
    size = max(v.co.length for v in bm.verts)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=size * 1e-5)
    bm.to_mesh(mesh.data)
    bm.free()
    mesh.data.shade_smooth()
    return mesh


def poly_z(pts, y):
    for (y0, z0), (y1, z1) in zip(pts, pts[1:]):
        if y1 <= y <= y0:
            return mix(z0, z1, (y0 - y) / (y0 - y1))
    return pts[-1][1] if y < pts[-1][0] else pts[0][1]


def cut_mouth(mesh, pts):
    """다문 입을 입선(앞뒤 y, 높이 z)을 따라 잘라 위턱과 아래턱을 나누고 입안을 채운다. 아래턱 정점 번호를 돌려준다."""
    corner = pts[0][0]
    bm = bmesh.new()
    bm.from_mesh(mesh.data)
    near = lambda f: f.calc_center_median().y < corner + 0.12 and abs(f.calc_center_median().z - poly_z(pts, f.calc_center_median().y)) < 0.5
    for y, _ in pts[:-1]:
        fs = [f for f in bm.faces if near(f)]
        geom = list({e for f in fs for e in f.edges} | {v for f in fs for v in f.verts}) + fs
        bmesh.ops.bisect_plane(bm, geom=geom, dist=1e-5, plane_co=(0, y, 0), plane_no=(0, 1, 0))
    for (y0, z0), (y1, z1) in zip(pts, pts[1:]):
        fs = [f for f in bm.faces if near(f) and y1 < f.calc_center_median().y < y0]
        geom = list({e for f in fs for e in f.edges} | {v for f in fs for v in f.verts}) + fs
        bmesh.ops.bisect_plane(bm, geom=geom, dist=1e-5, plane_co=(0, y0, z0), plane_no=Vector((0, z1 - z0, y0 - y1)).normalized())
    front = {f for f in bm.faces if f.calc_center_median().y < corner and abs(f.calc_center_median().z - poly_z(pts, f.calc_center_median().y)) < 1.6}
    low = {f for f in front if f.calc_center_median().z < poly_z(pts, f.calc_center_median().y)}
    up = front - low
    seam = [e for e in bm.edges if len(e.link_faces) == 2 and len({f in low for f in e.link_faces}) == 2
            and all(f in front for f in e.link_faces)]
    print('MOUTH 자른 변', len(seam))
    bmesh.ops.split_edges(bm, edges=seam)
    bm.verts.ensure_lookup_table()
    mats = []
    for name, color, rough in (('mouth', (0.22, 0.035, 0.035), 0.55), ('teeth', (0.78, 0.72, 0.58), 0.45)):
        mat = bpy.data.materials.new(name)
        mat.use_nodes = True
        n = next(x for x in mat.node_tree.nodes if x.type == 'BSDF_PRINCIPLED')
        n.inputs['Base Color'].default_value = (*color, 1)
        n.inputs['Roughness'].default_value = rough
        mesh.data.materials.append(mat)
        mats.append(len(mesh.data.materials) - 1)
    lower_new = set()
    for group, is_low in ((low, True), (up, False)):
        edges = [e for e in bm.edges if e.is_boundary and e.link_faces[0] in group]
        # 입선을 왼쪽 구석부터 오른쪽 구석까지 늘어놓는다.
        left = sorted([v for v in {v for e in edges for v in e.verts} if v.co.x >= 0], key=lambda v: -v.co.y)
        right = sorted([v for v in {v for e in edges for v in e.verts} if v.co.x < 0], key=lambda v: -v.co.y)
        # 같은 깊이의 왼쪽과 오른쪽을 이어 띠로 채운다.
        ys = np.linspace(corner - 0.01, min(v.co.y for v in left + right) + 0.02, 14)
        pick = lambda side, y: min(side, key=lambda v: abs(v.co.y - y))
        rows = []
        for y in ys:
            a, b = pick(left, y), pick(right, y)
            if not rows or (rows[-1][0] is not a and rows[-1][1] is not b):
                rows.append((a, b))
        for (a0, b0), (a1, b1) in zip(rows, rows[1:]):
            for tri in ((a0, a1, b1), (a0, b1, b0)):
                f = bm.faces.new([bm.verts.new(v.co) for v in (tri if is_low else tri[::-1])])
                f.material_index = mats[0]
                if is_low:
                    lower_new.update(f.verts)
        # 이빨: 입선 바로 안쪽에 원뿔을 세운다.
        for side in (left, right):
            for y in np.linspace(corner - 0.28, min(v.co.y for v in side) + 0.22, 11):
                p = pick(side, y).co.copy()
                # 입을 다물었을 때 밖으로 나오지 않게 안쪽으로 들인다.
                p.x *= 0.74
                p.y += 0.16 * smooth((-5.3 - p.y) / 0.5)
                h, r = (0.09, 0.03) if is_low else (0.13, 0.04)
                tip = bm.verts.new(p + Vector((0, 0, h if is_low else -h)))
                ring = [bm.verts.new(p + Vector((r * math.cos(TAU * i / 5), r * math.sin(TAU * i / 5), -0.03 if is_low else 0.03))) for i in range(5)]
                for i in range(5):
                    f = bm.faces.new((ring[i], ring[(i + 1) % 5], tip))
                    f.material_index = mats[1]
                if is_low:
                    lower_new.update([tip, *ring])
    low_verts = {v for f in low if f.is_valid for v in f.verts} | lower_new
    bmesh.ops.recalc_face_normals(bm, faces=[f for f in bm.faces if f.material_index in mats])
    bm.verts.index_update()
    idx = {v.index for v in low_verts}
    bm.to_mesh(mesh.data)
    bm.free()
    extra = {v for p in mesh.data.polygons if p.material_index in mats for v in p.vertices}
    caps = {v for p in mesh.data.polygons if p.material_index == mats[0] for v in p.vertices}
    return idx, extra, caps


def rig(mesh, sp, bones):
    jaw = sp['jaw']
    arm = bpy.data.objects.new('rig', bpy.data.armatures.new('rig'))
    bpy.context.scene.collection.objects.link(arm)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode='EDIT')
    for name, (head, tail, parent, deform) in bones.items():
        e = arm.data.edit_bones.new(name)
        e.head, e.tail, e.use_deform = head, tail, deform
        if parent:
            e.parent = arm.data.edit_bones[parent]
    bpy.ops.object.mode_set(mode='OBJECT')
    bpy.ops.object.select_all(action='DESELECT')
    mesh.select_set(True)
    arm.select_set(True)
    bpy.ops.object.parent_set(type='ARMATURE_AUTO')
    # 입안과 이빨이 자동 가중치 계산을 망치지 않도록 피부를 뼈에 연결한 뒤에 자른다.
    low, extra, caps = (cut_mouth(mesh, jaw['cut']) if 'cut' in jaw else (None, set(), set()))
    for n in ('jaw', 'root'):
        arm.data.bones[n].use_deform = True
        if n not in mesh.vertex_groups:
            mesh.vertex_groups.new(name=n)
    groups = mesh.vertex_groups
    names = {g.index: g.name for g in groups}

    def put(v, weights):
        for g in list(v.groups):
            groups[g.group].remove([v.index])
        top = sorted(((w, n) for n, w in weights.items() if w > 1e-3), reverse=True)[:4]
        total = sum(w for w, _ in top)
        for w, n in top:
            groups[n].add([v.index], w / total, 'REPLACE')

    hy, hz = jaw['hinge']
    ly, lz = jaw.get('line', (None, None))
    missing = jawed = 0
    final = {}
    # 입안 가장자리는 맞닿은 피부와 같은 비중으로 움직여야 틈이 벌어지지 않는다.
    at = lambda v: tuple(round(c, 4) for c in v.co)
    skin = {at(v): {names[g.group]: g.weight for g in v.groups if g.weight > 0} for v in mesh.data.vertices if v.index not in extra}
    for v in mesh.data.vertices:
        w = {names[g.group]: g.weight for g in v.groups if g.weight > 0}
        if v.index in caps:
            w = dict(skin.get(at(v)) or {'head': 1.0})
        elif v.index in extra or (low and v.index in low and not w):
            w = {'head': 1.0}
        if not w:
            missing += 1
            near = min((n for n, b in bones.items() if b[3]), key=lambda n: (Vector(bones[n][0]) - v.co).length)
            w = {near: 1.0}
        if 'rigid' in sp:
            r = sp['rigid'](v.co)
            if r > 0:
                w = {n: x * (1 - r) for n, x in w.items()}
                w['head'] = w.get('head', 0) + r
        if v.co.y < hy + jaw['fade'] * 0.2 and v.co.z > jaw['floor']:
            below = v.index in low if low is not None else v.co.z < mix(hz, lz, (hy - v.co.y) / (hy - ly))
            j = smooth((hy - v.co.y) / jaw['fade']) if below else 0.0
            if low is not None and v.index in extra and v.index not in caps and below:
                j = 1.0  # 이빨은 휘지 않게
            if j > 0:
                jawed += 1
                w = {n: x * (1 - j) for n, x in w.items()}
                w['jaw'] = j
        put(v, w)
        if v.index not in extra:
            final[(at(v), low is not None and v.index in low)] = {names[g.group]: g.weight for g in v.groups if g.weight > 0}
    same = 0
    for i in caps:
        v = mesh.data.vertices[i]
        w = final.get((at(v), i in low))
        if w:
            put(v, w)
            same += 1
    if caps:
        print('MOUTH 입안 정점', len(caps), '피부와 비중이 같은 정점', same)
        if same != len(caps):
            raise SystemExit('입안 가장자리와 맞닿은 피부를 찾지 못했습니다.')
    print('RIG 정점', len(mesh.data.vertices), '가까운 뼈로 채운 정점', missing, '턱 정점', jawed)
    return arm


# ---------- 동작 ----------
class Animator:
    def __init__(self, arm, sp, bones, K):
        self.arm, self.sp, self.bones, self.K = arm, sp, bones, K
        self.pb = arm.pose.bones
        self.rest = {b.name: b.bone.matrix_local.copy() for b in self.pb}
        self.prev = {}
        for b in self.pb:
            b.rotation_mode = 'QUATERNION'
        self.legs = []
        for leg in sp.get('legs', {}):
            for n in 'LR':
                self.legs.append((leg, n))
                ik = self.pb[f'{leg}Lower.{n}'].constraints.new('IK')
                ik.target, ik.subtarget, ik.chain_count, ik.iterations = arm, f'{leg}Ik.{n}', 2, 500
                cr = self.pb[f'{leg}Foot.{n}'].constraints.new('COPY_ROTATION')
                cr.target, cr.subtarget = arm, f'{leg}Ik.{n}'
        self.trunk = [n for n in ('pelvis', 'spine', 'chest') if n in bones]
        self.necks = [n for n in bones if n.startswith('neck')]
        self.tail = [n for n in bones if n.startswith('tail')]

    def key(self, name, q, f, loc=None):
        if name in self.prev and self.prev[name].dot(q) < 0:
            q = -q
        self.prev[name] = q
        b = self.pb[name]
        b.rotation_quaternion = q
        b.keyframe_insert('rotation_quaternion', frame=f)
        if loc is not None:
            b.location = loc
            b.keyframe_insert('location', frame=f)

    def rot(self, f, name, x=0.0, y=0.0, z=0.0, loc=None):
        """정지 자세의 모델 축을 기준으로 돌린다. x+ 고개 숙임(꼬리는 올림), y 좌우 기울기, z+ 왼쪽으로 돌림"""
        if name not in self.pb:
            return
        r = self.rest[name].to_3x3()
        m = Matrix.Rotation(math.radians(z), 3, 'Z') @ Matrix.Rotation(math.radians(y), 3, 'Y') @ Matrix.Rotation(math.radians(x), 3, 'X')
        self.key(name, (r.inverted() @ m @ r).to_quaternion(), f, None if loc is None else r.inverted() @ Vector(loc))

    def foot(self, f, leg, n, dy, dz, pitch, toe):
        name = f'{leg}Ik.{n}'
        ball = Vector(self.bones[name][1])
        mat = (Matrix.Translation((ball + Vector((0, dy, dz))) * self.K) @ Matrix.Rotation(math.radians(pitch), 4, 'X')
               @ Matrix.Translation(-ball * self.K) @ self.rest[name])
        loc, q, _ = (self.rest[name].inverted() @ mat).decompose()
        self.key(name, q, f, loc)
        if f'{leg}Toe.{n}' in self.pb:
            self.rot(f, f'{leg}Toe.{n}', x=toe - pitch)

    def chain_rot(self, f, names, x=0.0, y=0.0, z=0.0):
        for n in names:
            self.rot(f, n, x / len(names), y / len(names), z / len(names))

    def new_action(self, name):
        ad = self.arm.animation_data or self.arm.animation_data_create()
        ad.action = bpy.data.actions.new(name)
        self.prev = {}

    def stash(self):
        ad = self.arm.animation_data
        act = ad.action
        t = ad.nla_tracks.new()
        t.name = act.name
        t.strips.new(act.name, 0, act)
        t.mute = True
        ad.action = None

    def common(self, f, phase, sway, breath, w, look, g=None):
        """몸통 뒤쪽(꼬리)과 팔 같은 따라 움직이는 부분"""
        N = max(1, len(self.tail))
        for j, n in enumerate(self.tail):
            lag = TAU * phase - j * 0.5
            self.rot(f, n, x=(0.6 * w) * math.sin(2 * lag) * (6 / N), z=(1.3 + 0.35 * j) * math.sin(lag) * (6 / N) * (1 if w else 1.2))
        for n, o in (('L', 0.0), ('R', math.pi)):
            self.rot(f, f'arm0.{n}', x=mix(2.5, 6, w) * math.sin(TAU * phase + o))
            self.rot(f, f'arm1.{n}', x=mix(3, 5, w) * math.sin(TAU * phase + o + 0.6))

    def idle(self):
        self.new_action('idle')
        T, F = 8, 8 * FPS
        sp, K = self.sp, self.K
        unit = sp['length'] / 12
        L = sp['look']
        for f in range(F + 1):
            t = f / FPS
            br, sw = math.sin(TAU * t / 4), math.sin(TAU * t / T)

            def bump(a, b, c, e):
                return smooth((t - a) / (b - a)) * (1 - smooth((t - c) / (e - c)))
            yaw = bump(0.6, 1.6, 2.6, 3.6) - bump(4.4, 5.4, 6.2, 7.3)
            # 아래로만 움직여야 다리가 늘어나지 않는다.
            dz = (-0.03 + 0.02 * br) * unit
            self.rot(f, 'pelvis', x=-0.4 * br, y=0.6 * sw, loc=(0.03 * unit * sw * K, 0, dz * K))
            self.rot(f, 'spine', x=-0.4 * br, z=1.2 * yaw)
            self.rot(f, 'chest', x=-0.3 * br, z=1.8 * yaw)
            self.chain_rot(f, self.necks, x=1.2 * br, z=L * yaw)
            self.rot(f, 'head', x=-0.8 * br + 2 * abs(yaw), y=-2 * yaw, z=L * yaw)
            self.rot(f, 'jaw', x=-sp['jaw']['closed'])
            self.common(f, t / 4, sw, br, 0, yaw)
            for leg, n in self.legs:
                self.foot(f, leg, n, 0, 0, 0, 0)
        self.stash()
        return F

    def gait(self, name):
        sp, K = self.sp, self.K
        g = sp[name]
        running = name == 'run'
        F = max(8, round(g['stride'] / g['speed'] * FPS))
        speed = g['stride'] / (F / FPS)
        quad = 'fore' in sp['legs']
        if not quad:
            offs = {('hind', 'L'): 0, ('hind', 'R'): 0.5}
        elif running and sp['length'] < 15:  # 속보: 대각선 다리가 함께
            offs = {('hind', 'L'): 0, ('fore', 'R'): 0.03, ('hind', 'R'): 0.5, ('fore', 'L'): 0.53}
        else:  # 걷기: 왼뒤, 왼앞, 오른뒤, 오른앞
            offs = {('hind', 'L'): 0, ('fore', 'L'): 0.75, ('hind', 'R'): 0.5, ('fore', 'R'): 0.25}
        self.new_action(name)
        D, d = g['duty'], g['stride'] * g['duty']
        a = 1.0 if not quad else 0.55
        for f in range(F + 1):
            p = f / F
            s1, s2 = math.sin(TAU * p), math.sin(2 * TAU * p)
            mid = D / 2
            bob = (-g['bob'] if running else g['bob']) * math.cos(2 * TAU * (p - mid))
            self.rot(f, 'pelvis', x=(2.0 * running - 1.0 * s2) * a, y=2.5 * s1 * a, z=-4 * s1 * a,
                     loc=(0.1 * sp['length'] / 12 * s1 * K * (0.5 if running else 1), 0, (bob - g['crouch']) * K))
            self.rot(f, 'spine', z=2.5 * s1 * a)
            self.rot(f, 'chest', x=0.6 * s2 * a, z=2.5 * s1 * a)
            self.chain_rot(f, self.necks, x=(7 * running if not quad else 3 * running) + 2.0 * s2 * a, z=0.6 * s1 * a)
            self.rot(f, 'head', x=(-6 * running if not quad else -3 * running) - 2.0 * s2 * a)
            self.rot(f, 'jaw', x=-sp['jaw']['closed'] + (2 + 1.5 * s2) * running * quad)
            self.common(f, p, s1, 0, 1, 0, g)
            for leg, n in self.legs:
                u = (p - offs[(leg, n)]) % 1.0
                if u < D:
                    k = u / D
                    lift = g['roll'] * smooth((k - 0.55) / 0.45)
                    self.foot(f, leg, n, mix(-d / 2, d / 2, k), 0.06 * sp['length'] / 12 * lift / 34, lift, 0)
                else:
                    k = (u - D) / (1 - D)
                    fold = g['roll'] * (2.0 if running else 1.4)
                    pitch = mix(g['roll'], fold, smooth(k / 0.4)) if k < 0.4 else mix(fold, 0, smooth((k - 0.4) / 0.6))
                    dz = g['lift'] * math.sin(math.pi * k) ** 0.9 + 0.06 * sp['length'] / 12 * g['roll'] / 34 * (1 - k)
                    self.foot(f, leg, n, mix(d / 2, -d / 2, k * k * (3 - 2 * k)), dz, pitch, 25 * math.sin(math.pi * k) ** 2)
        self.stash()
        return F, speed

    def roar(self):
        sp, K = self.sp, self.K
        self.new_action('roar')
        T = sp['roar']
        F = round(T * FPS)
        unit = sp['length'] / 12
        quad = 'fore' in sp['legs']
        long_neck = len(self.necks) > 2
        for f in range(F + 1):
            t = f / FPS
            wind = smooth(t / 0.35) * (1 - smooth((t - 0.35) / 0.3))  # 숨 들이마시기
            e = smooth((t - 0.3) / 0.35) * (1 - smooth((t - (T - 0.9)) / 0.85))
            shake = e * math.sin(TAU * 5.5 * t)
            slow = e * math.sin(TAU * 0.6 * (t - 0.3))
            up = 16 if quad else 13
            self.rot(f, 'pelvis', x=(2 if quad else 4) * wind - (2 if quad else 5) * e, loc=(0, 0.05 * unit * wind * K, (-0.10 * wind - 0.13 * e) * unit * K))
            self.rot(f, 'spine', x=-(1 if quad else 3) * e, z=1.5 * slow)
            self.rot(f, 'chest', x=-(1 if quad else 3) * e, z=2 * slow)
            self.chain_rot(f, self.necks, x=8 * wind - (10 if long_neck else up * 0.5) * e, z=8 * slow)
            self.rot(f, 'head', x=8 * wind - up * e + 0.8 * shake, y=1.2 * shake, z=5 * slow + 1.0 * shake)
            self.rot(f, 'jaw', x=-sp['jaw']['closed'] + (sp['jaw']['closed'] + sp['jaw']['open']) * e + 1.0 * shake)
            for j, n in enumerate(self.tail):
                self.rot(f, n, x=1.2 * e, z=(1.5 + 0.5 * j) * e * math.sin(TAU * 0.9 * t - j * 0.5))
            for n in 'LR':
                self.rot(f, f'arm0.{n}', x=14 * e + 2 * shake)
                self.rot(f, f'arm1.{n}', x=-12 * e)
            for leg, n in self.legs:
                self.foot(f, leg, n, 0, 0, 0, 0)
        self.stash()
        return F

    # 익룡
    def fly(self, name, T, flap, speed_phase, pitch, loops=1, cry=False):
        sp, K = self.sp, self.K
        self.new_action(name)
        F = round(T * FPS)
        for f in range(F + 1):
            t = f / FPS
            e = smooth(t / 0.3) * (1 - smooth((t - (T - 0.6)) / 0.55)) if cry else 0.0
            ph = TAU * loops * f / F
            s = math.sin(ph)
            slow = math.sin(TAU * f / F)
            self.rot(f, 'pelvis', x=pitch + 1.5 * math.cos(ph) * min(1, flap / 20), y=0 if flap > 10 else 3 * slow,
                     loc=(0, 0, (-0.10 * math.sin(ph - 0.5) * min(1, flap / 22) + (0.04 * slow if flap < 10 else 0)) * K))
            self.rot(f, 'spine', x=-1.0 * math.cos(ph) * min(1, flap / 20))
            self.chain_rot(f, self.necks, x=-11 - 6 * e + 1.5 * math.cos(ph) * min(1, flap / 20), z=3 * slow * (flap < 10))
            self.rot(f, 'head', x=-18 - 6 * e, z=sp['look'] * slow * (flap < 10) + 2 * e * math.sin(TAU * 4 * t))
            self.rot(f, 'jaw', x=-sp['jaw']['closed'] + (sp['jaw']['closed'] + sp['jaw']['open']) * e * (0.75 + 0.25 * math.sin(TAU * 3.2 * t)))
            base = [4, 2, -1, -2]
            amp = [1.0, 0.35, 0.5, 0.45]
            lag = [0.0, 0.45, 0.8, 1.2]
            for i in range(4):
                a = base[i] + flap * amp[i] * math.sin(ph - lag[i]) + (1.2 * slow if flap < 10 else 0)
                for n, sg in (('L', -1), ('R', 1)):
                    self.rot(f, f'wing{i}.{n}', y=sg * a, x=(-0.25 * flap * math.cos(ph) if i == 0 else 0), z=(-sg * 3 * max(0, s) * min(1, flap / 20) if i == 1 else 0))
            for n, o in (('L', 0), ('R', 0.6)):
                self.rot(f, f'leg0.{n}', x=4 + 2 * math.sin(ph + o))
                self.rot(f, f'leg1.{n}', x=2 + 2 * math.sin(ph + o + 0.5))
        self.stash()
        return F


def verts_of(ob):
    e = ob.evaluated_get(bpy.context.evaluated_depsgraph_get())
    m = e.to_mesh()
    a = np.empty(len(m.vertices) * 3, np.float32)
    m.vertices.foreach_get('co', a)
    e.to_mesh_clear()
    w = np.array(e.matrix_world)
    return a.reshape(-1, 3) @ w[:3, :3].T + w[:3, 3]


def use(arm, name):
    ad = arm.animation_data
    ad.action = bpy.data.actions[name]
    if hasattr(ad, 'action_slot') and ad.action_slot is None and ad.action.slots:
        ad.action_slot = ad.action.slots[0]


def check(name, sp, mesh, arm, info, K, bones):
    """발 미끄러짐, 바닥 파임, 이음새, 늘어남을 실제 크기 미터로 잰다."""
    sc = bpy.context.scene
    edges = np.array([e.vertices[:] for e in mesh.data.edges])
    rest0 = np.array([v.co for v in mesh.data.vertices]) / K
    rl = np.linalg.norm(rest0[edges[:, 0]] - rest0[edges[:, 1]], axis=1) + 1e-6
    for act in ('idle', 'walk', 'run', 'roar'):
        use(arm, act)
        F = info[act]['frames']
        fr = []
        for f in range(F + 1):
            sc.frame_set(f)
            fr.append(verts_of(mesh) / K)
        seam = float(np.linalg.norm(fr[0] - fr[-1], axis=1).max())
        jump = max(float(np.linalg.norm(b - a, axis=1).max()) for a, b in zip(fr, fr[1:]))
        st = max(float(np.percentile(np.linalg.norm(p[edges[:, 0]] - p[edges[:, 1]], axis=1) / rl, 99.9)) for p in fr)
        low = min(float(p[:, 2].min()) for p in fr)
        text = f'CHECK {name}/{act} 이음새 {seam:.3f} m, 프레임당 이동 {jump:.2f} m, 늘어남 {st:.2f}배'
        if not sp.get('fly'):
            text += f', 최저점 {low:.3f} m'
            slide, v = 0.0, info[act].get('speed', 0.0)
            for leg in sp['legs']:
                for n in 'LR':
                    ball = np.array(bones[f'{leg}Ik.{n}'][1])
                    sel = (np.hypot(rest0[:, 0] - ball[0], rest0[:, 1] - ball[1]) < 0.03 * sp['length']) & (rest0[:, 2] < 0.012 * sp['length'])
                    if not sel.any():
                        raise SystemExit(f'발을 찾지 못해 검사할 수 없습니다: {name}/{act}/{leg}.{n}')
                    tr = np.array([p[sel].mean(0) for p in fr])
                    down = tr[:, 2] < tr[:, 2].min() + 0.006 * sp['length']
                    for i in range(F):
                        if down[i] and down[i + 1]:
                            slide = max(slide, abs((tr[i + 1, 1] - tr[i, 1]) - v / FPS))
            text += f', 디딘 발 프레임당 오차 {slide:.3f} m'
        print(text)


def preview(name, sp, arm, info, K, out):
    sc = bpy.context.scene
    sc.render.engine = 'BLENDER_WORKBENCH'
    sc.display.shading.color_type = 'TEXTURE'
    sc.display.shading.light = 'STUDIO'
    sc.view_settings.view_transform = 'Standard'
    sc.render.resolution_x, sc.render.resolution_y = 480, 320
    cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))
    cam.data.clip_start, cam.data.clip_end = .001, 50
    cam.data.lens = 42
    sc.collection.objects.link(cam)
    sc.camera = cam
    L = DESK
    z = {'brachiosaurus': .38, 'pteranodon': .16}.get(name, .16) * L
    for act, n in (('walk', 4), ('run', 4), ('roar', 4)):
        use(arm, act)
        F = info[act]['frames']
        for j in range(n):
            sc.frame_set(round(F * (j + .5) / n if act == 'roar' else F * j / n))
            d = Vector((-1.0, -.55, .22) if not sp.get('fly') else (-.75, -1.0, .45)).normalized()
            aim = Vector((0, -.02 * L, z))
            cam.location = aim + d * L * 1.75
            cam.rotation_euler = (aim - cam.location).to_track_quat('-Z', 'Y').to_euler()
            sc.render.filepath = os.path.join(out, f'{name}-{act}{j}.png')
            bpy.ops.render.render(write_still=True)


def main():
    args = sys.argv[sys.argv.index('--') + 1:]
    src, out = os.path.abspath(args[0]), os.path.abspath(args[1])
    prev = os.path.abspath(args[2]) if len(args) > 2 and args[2] != '-' else None
    only = args[3].split(',') if len(args) > 3 else list(SPECIES)
    os.makedirs(out, exist_ok=True)
    if prev:
        os.makedirs(prev, exist_ok=True)
    for name in only:
        sp = SPECIES[name]
        K = DESK / sp['length']
        bones = skeleton(sp)
        mesh = load(os.path.join(src, f'{name}.glb'))
        arm = rig(mesh, sp, bones)
        arm.scale = (K,) * 3
        bpy.ops.object.select_all(action='DESELECT')
        arm.select_set(True)
        mesh.select_set(True)
        bpy.context.view_layer.objects.active = arm
        bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
        bpy.context.scene.render.fps = FPS
        an = Animator(arm, sp, bones, K)
        info = {}
        if sp.get('fly'):
            info['idle'] = dict(frames=an.fly('idle', 4, 3, 1, 12), speed=7.0)
            info['walk'] = dict(frames=an.fly('walk', 1.25, 22, 1, 10), speed=7.0)
            info['run'] = dict(frames=an.fly('run', 0.75, 30, 1, 14), speed=13.0)
            info['roar'] = dict(frames=an.fly('roar', sp['roar'], 18, 1, 8, loops=2, cry=True), speed=6.0)
        else:
            info['idle'] = dict(frames=an.idle())
            for g in ('walk', 'run'):
                f, v = an.gait(g)
                info[g] = dict(frames=f, speed=v)
            info['roar'] = dict(frames=an.roar())
        print('INFO', name, json.dumps({k: {a: round(b, 3) for a, b in v.items()} for k, v in info.items()}))
        check(name, sp, mesh, arm, info, K, bones)
        if prev:
            preview(name, sp, arm, info, K, prev)
            for o in [o for o in bpy.data.objects if o.type == 'CAMERA']:
                bpy.data.objects.remove(o)
        arm.animation_data.action = None
        for b in arm.pose.bones:
            b.matrix_basis.identity()
        bpy.context.scene.frame_set(0)
        bpy.ops.object.select_all(action='SELECT')
        path = os.path.join(out, f'{name}.glb')
        bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True, export_yup=True, export_animations=True,
                                  export_animation_mode='ACTIONS', export_force_sampling=True, export_def_bones=True,
                                  export_image_format='AUTO', export_influence_nb=4)
        print('OUT', name, os.path.getsize(path))


main()
