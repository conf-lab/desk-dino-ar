# 정지한 티라노 모델에 뼈대와 8초 반복 동작(숨쉬기, 고개, 꼬리)을 넣는다.
# 사용: blender -b --factory-startup -P scripts/rig-trex.py -- <정지 모델.glb> <출력 폴더> [미리보기 폴더]
# 관절 좌표는 12m 모델 기준(Blender: 앞 -Y, 위 +Z)으로 잰 값이다.
import math
import os
import sys

import bpy
from mathutils import Vector

args = sys.argv[sys.argv.index('--') + 1:]
src, out_dir = os.path.abspath(args[0]), os.path.abspath(args[1])
preview = os.path.abspath(args[2]) if len(args) > 2 else None
os.makedirs(out_dir, exist_ok=True)

FPS, SECONDS = 24, 8
FRAMES = FPS * SECONDS
TAU = math.tau

# 이름: (시작, 끝, 부모, 변형에 쓰는 뼈인가)
BONES = {
    'root': ((0, 0, 0), (0, -0.6, 0), None, False),
    'pelvis': ((0, 0.3, 2.75), (0, -1.0, 2.75), 'root', True),
    'spine': ((0, -1.0, 2.75), (0, -2.1, 2.8), 'pelvis', True),
    'chest': ((0, -2.1, 2.8), (0, -3.1, 2.95), 'spine', True),
    'neck': ((0, -3.1, 2.95), (0, -3.95, 3.65), 'chest', True),
    'head': ((0, -3.95, 3.65), (0, -5.9, 3.6), 'neck', True),
}
TAIL = [(0.3, 2.75), (1.0, 2.68), (1.8, 2.63), (2.6, 2.6), (3.4, 2.59), (4.2, 2.58), (5.0, 2.53), (5.95, 2.36)]
for i, ((y0, z0), (y1, z1)) in enumerate(zip(TAIL, TAIL[1:])):
    BONES[f'tail{i}'] = ((0, y0, z0), (0, y1, z1), f'tail{i - 1}' if i else 'pelvis', True)
for s, n in ((1, 'L'), (-1, 'R')):
    hip, knee, ankle = (0.62 * s, -0.8, 2.75), (0.85 * s, -1.4, 1.9), (0.87 * s, -0.95, 1.0)
    ball, toe = (0.95 * s, -1.2, 0.2), (1.05 * s, -1.9, 0.12)
    BONES[f'thigh.{n}'] = (hip, knee, 'pelvis', True)
    BONES[f'shin.{n}'] = (knee, ankle, f'thigh.{n}', True)
    BONES[f'foot.{n}'] = (ankle, ball, f'shin.{n}', True)
    BONES[f'toe.{n}'] = (ball, toe, f'foot.{n}', True)
    BONES[f'ik.{n}'] = (ankle, ball, 'root', False)
    shoulder, elbow, hand = (0.5 * s, -3.15, 2.6), (0.6 * s, -3.15, 2.28), (0.42 * s, -3.3, 1.92)
    BONES[f'arm.{n}'] = (shoulder, elbow, 'chest', True)
    BONES[f'forearm.{n}'] = (elbow, hand, f'arm.{n}', True)


def build(scale):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=src)
    mesh = next(o for o in bpy.data.objects if o.type == 'MESH')
    world = mesh.matrix_world.copy()
    mesh.parent = None
    mesh.data.transform(world)
    mesh.matrix_world.identity()
    for o in [o for o in bpy.data.objects if o is not mesh]:
        bpy.data.objects.remove(o)

    # UV 경계에서 나뉜 정점을 합쳐야 뼈를 움직일 때 틈이 벌어지지 않는다.
    bpy.context.view_layer.objects.active = mesh
    mesh.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.mesh.remove_doubles(threshold=0.0001)
    bpy.ops.object.mode_set(mode='OBJECT')
    mesh.data.shade_smooth()

    arm = bpy.data.objects.new('trex', bpy.data.armatures.new('trex'))
    bpy.context.scene.collection.objects.link(arm)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode='EDIT')
    for name, (head, tail, parent, deform) in BONES.items():
        b = arm.data.edit_bones.new(name)
        b.head, b.tail, b.use_deform = head, tail, deform
        # 좌우 회전 = 로컬 Z, 위아래 = 로컬 X가 되도록 축을 맞춘다.
        if abs(Vector(tail).x - Vector(head).x) < 1e-6:
            b.align_roll((0, 0, 1))
        if parent:
            b.parent = arm.data.edit_bones[parent]
    bpy.ops.object.mode_set(mode='OBJECT')

    bpy.ops.object.select_all(action='DESELECT')
    mesh.select_set(True)
    arm.select_set(True)
    bpy.ops.object.parent_set(type='ARMATURE_AUTO')
    bpy.ops.object.select_all(action='DESELECT')
    mesh.select_set(True)
    bpy.context.view_layer.objects.active = mesh
    bpy.ops.object.vertex_group_limit_total(group_select_mode='ALL', limit=4)
    bpy.ops.object.vertex_group_normalize_all(lock_active=False)
    unweighted = sum(1 for v in mesh.data.vertices if sum(g.weight for g in v.groups) < 0.99)
    print('RIG verts', len(mesh.data.vertices), 'unweighted', unweighted)
    if unweighted:
        raise SystemExit('가중치가 없는 정점이 있습니다.')

    arm.scale = (scale,) * 3
    bpy.ops.object.select_all(action='DESELECT')
    arm.select_set(True)
    mesh.select_set(True)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return mesh, arm


def animate(arm, scale):
    sc = bpy.context.scene
    sc.render.fps = FPS
    sc.frame_start, sc.frame_end = 0, FRAMES
    pb = arm.pose.bones
    for b in pb:
        b.rotation_mode = 'XYZ'
    for n in 'LR':
        ik = pb[f'shin.{n}'].constraints.new('IK')
        ik.target, ik.subtarget, ik.chain_count = arm, f'ik.{n}', 2
        cr = pb[f'foot.{n}'].constraints.new('COPY_ROTATION')
        cr.target, cr.subtarget = arm, f'ik.{n}'

    d = math.radians

    def smooth(x):
        x = max(0.0, min(1.0, x))
        return x * x * (3 - 2 * x)

    def look(t):  # 정면 → 왼쪽 → 정면 → 오른쪽 → 정면
        def bump(a, b, c, e):
            return smooth((t - a) / (b - a)) * (1 - smooth((t - c) / (e - c)))
        return bump(0.6, 1.5, 2.6, 3.6) - bump(4.4, 5.3, 6.2, 7.3)

    for f in range(FRAMES + 1):
        t = f / FPS
        breath = math.sin(TAU * t / 4)
        sway = math.sin(TAU * t / 8)
        yaw = look(t)

        def rot(name, x=0.0, y=0.0, z=0.0):
            pb[name].rotation_euler = (d(x), d(y), d(z))
            pb[name].keyframe_insert('rotation_euler', frame=f)

        pb['pelvis'].location = (0.05 * sway * scale, 0, 0.025 * breath * scale)
        pb['pelvis'].keyframe_insert('location', frame=f)
        rot('pelvis', x=0.5 * breath, y=0.8 * sway)
        rot('spine', x=0.5 * breath, z=1.5 * yaw)
        rot('chest', x=0.4 * breath, z=2.5 * yaw)
        k = 1 + 0.016 * breath
        pb['chest'].scale = (k, 1, k)
        pb['chest'].keyframe_insert('scale', frame=f)
        rot('neck', x=-1.2 * breath, z=9 * yaw)
        rot('head', x=1.0 * breath + 2.0 * abs(yaw), y=2.5 * yaw, z=11 * yaw)
        for i in range(len(TAIL) - 1):
            phase = TAU * t / 4 - i * 0.55
            rot(f'tail{i}', x=0.5 * math.sin(TAU * t / 8 - i * 0.4), z=(1.2 + 0.5 * i) * math.sin(phase))
        for n, o in (('L', 0.0), ('R', 0.9)):
            rot(f'arm.{n}', x=2.5 * math.sin(TAU * t / 4 + o))
            rot(f'forearm.{n}', x=4 * math.sin(TAU * t / 4 + o + 0.6))
    arm.animation_data.action.name = 'idle'


def check(mesh, scale, label):
    sc = bpy.context.scene

    def verts(f):
        sc.frame_set(f)
        e = mesh.evaluated_get(bpy.context.evaluated_depsgraph_get())
        m = e.to_mesh()
        r = [e.matrix_world @ v.co for v in m.vertices]
        e.to_mesh_clear()
        return [p / scale for p in r]

    first = verts(0)
    feet = [i for i, p in enumerate(first) if p.z < 0.5]
    slide = move = 0.0
    low, high_floor = math.inf, -math.inf
    for f in range(FRAMES + 1):
        p = verts(f)
        slide = max(slide, max((p[i] - first[i]).length for i in feet))
        floor = min(q.z for q in p)
        low, high_floor = min(low, floor), max(high_floor, floor)
        move = max(move, max((a - b).length for a, b in zip(p, first)))
    last = verts(FRAMES)
    seam = max((a - b).length for a, b in zip(first, last))
    length = max(p.y for p in first) - min(p.y for p in first)
    print(f'CHECK {label}(12m 기준) 길이 {length:.3f} m, 발 미끄러짐 {slide:.4f} m, 바닥 {low:.4f}~{high_floor:.4f} m, 최대 움직임 {move:.2f} m, 반복 이음새 {seam:.5f} m')


def export(path):
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.export_scene.gltf(
        filepath=path, export_format='GLB', use_selection=True, export_yup=True,
        export_animations=True, export_animation_mode='ACTIONS', export_force_sampling=True,
        export_def_bones=True, export_image_format='AUTO', export_influence_nb=4,
    )


def render(mesh):
    sc = bpy.context.scene
    sc.render.engine = 'BLENDER_WORKBENCH'
    sc.display.shading.color_type = 'TEXTURE'
    sc.display.shading.light = 'FLAT'
    sc.render.resolution_x, sc.render.resolution_y = 640, 400
    for name, loc, aim in (('side', (-15, -6, 5), (0, 0, 2.2)), ('top', (-3, -12, 10), (0, 0, 2.2))):
        cam = bpy.data.objects.new(name, bpy.data.cameras.new(name))
        cam.data.lens = 38
        sc.collection.objects.link(cam)
        cam.location = loc
        cam.rotation_euler = (Vector(aim) - Vector(loc)).to_track_quat('-Z', 'Y').to_euler()
        sc.camera = cam
        for f in (0, 50, 96, 140):
            sc.frame_set(f)
            sc.render.filepath = os.path.join(preview, f'{name}-{f:03d}.png')
            bpy.ops.render.render(write_still=True)
        bpy.data.objects.remove(cam)


for mode, scale in (('desk', 0.3 / 12), ('real', 1.0)):
    mesh, arm = build(scale)
    animate(arm, scale)
    check(mesh, scale, f'{mode} 내보내기 전')
    if preview and mode == 'real':
        os.makedirs(preview, exist_ok=True)
        render(mesh)
    path = os.path.join(out_dir, f'trex-{mode}.glb')
    export(path)
    # 내보낸 파일을 다시 불러와 실제 배포본을 검사한다.
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.scene.render.fps = FPS
    bpy.ops.import_scene.gltf(filepath=path)
    skinned = [o for o in bpy.data.objects if o.type == 'MESH' and any(m.type == 'ARMATURE' for m in o.modifiers)]
    check(skinned[0], scale, f'{mode} 배포본')
