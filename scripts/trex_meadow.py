# 초원 받침 위를 티라노가 걷고 뛰며 한 바퀴 도는 20초 반복 장면을 만든다.
# 사용: blender -b --factory-startup -P scripts/trex_meadow.py -- <정지 모델.glb> <출력 폴더> [미리보기 폴더]
# 모든 길이는 12m 티라노 기준 미터로 쓰고, 마지막에 K를 곱해 책상 크기로 만든다.
import math
import os
import random
import sys

import bpy
import numpy as np
from mathutils import Matrix, Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import trex_rig as rig  # noqa: E402

TAU = math.tau
FPS = rig.FPS
SECONDS = 20
FRAMES = FPS * SECONDS

RADIUS = 22.0  # 초원 반지름
PATH = 14.0  # 티라노 엉덩이가 도는 원의 반지름
SOIL = 1.0  # 받침 두께
K = 0.55 / (2 * RADIUS)  # 초원 지름 55cm
LAP = TAU * PATH
HIP = Vector((0, -0.9, 0))

SUB = 20  # 프레임 하나를 나눠 적분하는 수
DT = 1 / (FPS * SUB)
STEPS = FRAMES * SUB


def smooth(x):
    x = max(0.0, min(1.0, x))
    return x * x * (3 - 2 * x)


def mix(a, b, t):
    return a + (b - a) * t


# ---------- 걸음 계획 ----------
def raw_speed(t):  # 멈춤 → 걷기 → 뛰기 → 걷기 → 멈춤 (m/s)
    walk = smooth((t - 2.5) / 1.5) * (1 - smooth((t - 17.0) / 1.5))
    run = smooth((t - 7.5) / 1.5) * (1 - smooth((t - 14.0) / 1.5))
    return 3.0 * walk + 5.6 * run


def run_amount(v):
    return smooth((v - 3.2) / 4.0)


def duty_of(v):  # 한 발이 땅에 닿아 있는 비율
    return mix(0.62, 0.38, run_amount(v))


def stride_of(v):  # 같은 발이 다시 닿을 때까지의 거리
    return mix(mix(2.4, 3.3, smooth(v / 3.0)), 5.4, run_amount(v))


class Gait:
    def __init__(self):
        raw = np.array([raw_speed(i * DT) for i in range(STEPS)])
        self.gain = LAP / (raw.sum() * DT)  # 정확히 한 바퀴
        v = raw * self.gain
        f = np.array([x / stride_of(x) for x in v])
        strides = round(f.sum() * DT)
        f *= strides / (f.sum() * DT)  # 걸음 수도 정수로 맞춰 이음새를 없앤다
        self.v = v
        self.s = np.concatenate([[0], np.cumsum(v) * DT])
        # 0.06에서 시작하면 멈춰 있을 때 두 발이 모두 땅에 있다.
        self.p = np.concatenate([[0], np.cumsum(f) * DT]) + 0.06
        self.strides = strides

    def _at(self, arr, i, span):
        laps, j = divmod(i, STEPS)
        return arr[j] + laps * span

    def dist(self, i):
        return self._at(self.s, i, LAP)

    def phase(self, i):
        return self._at(self.p, i, self.strides)

    def speed(self, i):
        return float(self.v[i % STEPS])

    def stances(self, offset):
        """(닿는 시각, 떨어지는 시각, 딛는 거리) 목록. 앞뒤로 한 바퀴씩 더 구한다."""
        out, start = [], None
        for i in range(-STEPS, 2 * STEPS):
            down = (self.phase(i) + offset) % 1.0 < duty_of(self.speed(i))
            if down and start is None:
                start = i
            elif not down and start is not None:
                out.append((start, i, (self.dist(start) + self.dist(i)) / 2))
                start = None
        return out


def heading(s):
    phi = s / PATH - math.pi / 2  # 보는 사람 바로 앞에서 옆모습으로 출발한다
    return Vector((PATH * math.cos(phi), PATH * math.sin(phi), 0)), phi + math.pi


def on_path(s, local):
    pos, yaw = heading(s)
    return pos + Matrix.Rotation(yaw, 3, 'Z') @ (Vector(local) - HIP)


def push_off(gait, i):  # 발을 뗄 때의 발목 각도. 느릴수록 작다
    return 34 * smooth(gait.speed(i) / 1.5)


def foot_pose(gait, stances, i, ball):
    """공(발가락 뿌리) 위치, 방향, 발목 기울기, 발가락 기울기(도)"""
    for n, (a, b, s) in enumerate(stances):
        if a <= i < b:
            u = (i - a) / (b - a)
            lift = push_off(gait, b) * smooth((u - 0.55) / 0.45)
            p = on_path(s, ball)
            p.z += 0.06 * lift / 34  # 발목을 들 때 발볼이 땅에 묻히지 않게
            return p, heading(s)[1], lift, 0.0
        if i < a:
            pa, pb, ps = stances[n - 1]
            u = (i - pb) / (a - pb)
            e = u * u * (3 - 2 * u)
            p = on_path(ps, ball).lerp(on_path(s, ball), e)
            r = run_amount(gait.speed(i))
            start = push_off(gait, pb)
            p.z += mix(0.35, 0.75, r) * math.sin(math.pi * u) ** 0.9 + 0.06 * start / 34 * (1 - u)
            fold = mix(48, 70, r)
            pitch = mix(start, fold, smooth(u / 0.4)) if u < 0.4 else mix(fold, 0, smooth((u - 0.4) / 0.6))
            toe = mix(22, 34, r) * math.sin(math.pi * u) ** 2
            return p, mix(heading(ps)[1], heading(s)[1], e), pitch, toe
    raise RuntimeError('걸음 계획이 비었습니다.')


# ---------- 동작 ----------
def animate(arm):
    sc = bpy.context.scene
    sc.render.fps = FPS
    sc.frame_start, sc.frame_end = 0, FRAMES
    gait = Gait()
    print(f'GAIT 걸음 {gait.strides}회, 최고 속도 {gait.v.max():.2f} m/s')
    pb = arm.pose.bones
    rest = {b.name: b.bone.matrix_local.copy() for b in pb}
    for b in pb:
        b.rotation_mode = 'XYZ'
    for n in ('root', 'ik.L', 'ik.R', 'toe.L', 'toe.R'):
        pb[n].rotation_mode = 'QUATERNION'
    for n in 'LR':
        ik = pb[f'shin.{n}'].constraints.new('IK')
        ik.target, ik.subtarget, ik.chain_count, ik.iterations = arm, f'ik.{n}', 2, 500
        cr = pb[f'foot.{n}'].constraints.new('COPY_ROTATION')
        cr.target, cr.subtarget = arm, f'ik.{n}'
    feet = {n: (gait.stances(o), Vector(rig.BONES[f'toe.{n}'][0])) for n, o in (('L', 0.0), ('R', 0.5))}
    d = math.radians
    prev = {}
    ground = SOIL

    def place(name, mat, f):
        basis = rest[name].inverted() @ mat
        loc, q, _ = basis.decompose()
        if name in prev and prev[name].dot(q) < 0:
            q = -q
        prev[name] = q
        pb[name].location, pb[name].rotation_quaternion = loc, q
        pb[name].keyframe_insert('location', frame=f)
        pb[name].keyframe_insert('rotation_quaternion', frame=f)

    def rot(name, f, x=0.0, y=0.0, z=0.0):
        pb[name].rotation_euler = (d(x), d(y), d(z))
        pb[name].keyframe_insert('rotation_euler', frame=f)

    for f in range(FRAMES + 1):
        i = f * SUB
        t = f / FPS
        v, p = gait.speed(i), gait.phase(i)
        r = run_amount(v)
        w = smooth(v / 2.5)  # 0 멈춤, 1 이동
        still = 1 - w
        breath = math.sin(TAU * t / 4)
        pos, yaw = heading(gait.dist(i))

        root = pos + Matrix.Rotation(yaw, 3, 'Z') @ (-HIP)
        m = Matrix.Translation((root + Vector((0, 0, ground))) * K) @ Matrix.Rotation(yaw, 4, 'Z') @ rest['root']
        place('root', m, f)

        walk_bob = 0.05 * math.cos(2 * TAU * (p - 0.31))
        run_bob = -0.13 * math.cos(2 * TAU * (p - 0.19))
        z = still * (-0.10 + 0.025 * breath) + w * mix(-0.17 + walk_bob, -0.22 + run_bob, r)
        sway = 0.10 * math.sin(TAU * (p - 0.06)) * w * (1 - 0.5 * r)
        # pelvis의 로컬 축: X=좌우(부호 반대), Y=앞, Z=위
        pb['pelvis'].location = (sway * K, 0, z * K)
        pb['pelvis'].keyframe_insert('location', frame=f)
        swing = math.sin(TAU * (p - 0.06))
        double = math.sin(2 * TAU * (p - 0.06))
        rot('pelvis', f, x=-2.0 * r * w + 1.2 * double * w + 0.4 * breath * still, y=mix(2.5, 3.0, r) * swing * w, z=4 * swing * w)

        look = still * (math.sin(TAU * t / 5.0) if t < 10 else math.sin(TAU * (t - SECONDS) / 5.0))
        bend = 3.5
        rot('spine', f, x=0.4 * breath * still, z=bend - 2.5 * swing * w + 1.5 * look)
        rot('chest', f, x=-0.6 * double * w, z=bend - 2.0 * swing * w + 2.5 * look)
        k = 1 + 0.016 * breath * still
        pb['chest'].scale = (k, 1, k)
        pb['chest'].keyframe_insert('scale', frame=f)
        rot('neck', f, x=mix(0, -9, r) * w - 2.0 * double * w - 1.0 * breath * still, z=bend + 9 * look)
        rot('head', f, x=mix(0, 7, r) * w + 2.2 * double * w + 1.0 * breath * still, y=2.5 * look, z=2 + 11 * look)
        for j in range(len(rig.TAIL) - 1):
            lag = TAU * (p - 0.06) - j * 0.5
            z_tail = -3.2 + w * (1.6 + 0.35 * j) * math.sin(lag) + still * (1.2 + 0.5 * j) * math.sin(TAU * t / 4 - j * 0.55)
            x_tail = w * mix(0.8, 1.6, r) * math.sin(2 * lag) + (1.2 if j == 0 else 0.3) * r
            rot(f'tail{j}', f, x=x_tail, z=z_tail)
        for n, o in (('L', 0.0), ('R', math.pi)):
            a = TAU * p + o
            rot(f'arm.{n}', f, x=w * mix(5, 9, r) * math.sin(a) + still * 2.5 * math.sin(TAU * t / 4 + o))
            rot(f'forearm.{n}', f, x=w * mix(4, 7, r) * math.sin(a + 0.6) + still * 3 * math.sin(TAU * t / 4 + o + 0.6))

        for n, (stances, ball) in feet.items():
            ball_pos, foot_yaw, pitch, toe = foot_pose(gait, stances, i, ball)
            ball_pos = ball_pos + Vector((0, 0, ground))
            turn = Matrix.Translation(ball_pos * K) @ Matrix.Rotation(foot_yaw, 4, 'Z')
            local = Matrix.Translation(-ball * K)
            place(f'ik.{n}', turn @ Matrix.Rotation(d(pitch), 4, 'X') @ local @ rest[f'ik.{n}'], f)
            # 발가락: 발목이 기울어도 땅과 나란하게 되돌린 뒤 조금만 굽힌다.
            foot_rot = Matrix.Rotation(d(pitch), 4, 'X') @ rest[f'foot.{n}']
            rest_rel = rest[f'foot.{n}'].inverted() @ rest[f'toe.{n}']
            want = Matrix.Rotation(d(toe), 4, 'X') @ rest[f'toe.{n}']
            q = ((foot_rot @ rest_rel).inverted() @ want).to_quaternion()
            pb[f'toe.{n}'].rotation_quaternion = q
            pb[f'toe.{n}'].keyframe_insert('rotation_quaternion', frame=f)
    arm.animation_data.action.name = 'play'
    return gait, feet


# ---------- 초원 ----------
def material(name, color, rough=1.0, image=None, alpha=False):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = next(n for n in mat.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
    bsdf.inputs['Base Color'].default_value = (*color, 1)
    bsdf.inputs['Roughness'].default_value = rough
    if image:
        tex = mat.node_tree.nodes.new('ShaderNodeTexImage')
        tex.image = image
        mat.node_tree.links.new(tex.outputs['Color'], bsdf.inputs['Base Color'])
        if alpha:
            mat.node_tree.links.new(tex.outputs['Alpha'], bsdf.inputs['Alpha'])
    return mat


def picture(name, rgba, fmt):
    h, w = rgba.shape[:2]
    img = bpy.data.images.new(name, w, h, alpha=fmt == 'PNG')
    img.pixels.foreach_set(rgba.astype(np.float32).ravel())
    img.file_format = fmt
    path = os.path.join(bpy.app.tempdir, f'{name}.{fmt.lower()}')
    img.filepath_raw = path
    img.save()
    return bpy.data.images.load(path)


def noise(size, cells, rng):
    g = rng.random((cells, cells))
    x = np.linspace(0, cells, size, endpoint=False)
    i = x.astype(int)
    t = x - i
    t = t * t * (3 - 2 * t)
    a, b = i % cells, (i + 1) % cells
    rows = g[a][:, a] * (1 - t) + g[a][:, b] * t
    rows2 = g[b][:, a] * (1 - t) + g[b][:, b] * t
    return rows * (1 - t)[:, None] + rows2 * t[:, None]


def ground_image():
    size, rng = 1024, np.random.default_rng(7)
    n = sum(noise(size, c, rng) * a for c, a in ((6, .4), (19, .28), (61, .18), (190, .14)))
    fine = noise(size, 400, rng)
    yy, xx = np.mgrid[0:size, 0:size]
    c = (np.stack([xx, yy], -1) / size - 0.5) * 2 * RADIUS
    rad = np.hypot(c[..., 0], c[..., 1])
    green = np.array([.23, .36, .12]) * (0.65 + 0.75 * n[..., None]) + np.array([.07, .05, 0]) * fine[..., None]
    dirt = np.array([.43, .33, .21]) * (0.7 + 0.5 * n[..., None] + 0.15 * fine[..., None])
    trail = np.clip(1.15 - np.abs(rad - PATH) / 1.9 + (n - .5) * 1.4, 0, 1)[..., None] * .75
    shore = np.clip(1 - np.abs(rad - 4.3) / 0.9, 0, 1)[..., None] * .7
    k = np.maximum(trail, shore)
    rgb = np.clip(green * (1 - k) + dirt * k, 0, 1)
    return picture('ground', np.dstack([rgb, np.ones((size, size))]), 'JPEG')


def shadow_image():
    size = 128
    yy, xx = np.mgrid[0:size, 0:size] / (size - 1) * 2 - 1
    a = np.clip(1 - np.hypot(xx, yy), 0, 1) ** 1.3 * 0.5
    return picture('shadow', np.dstack([np.zeros((size, size, 3)), a]), 'PNG')


class Builder:
    def __init__(self):
        self.v, self.f = [], []

    def add(self, verts, faces):
        o = len(self.v)
        self.v += [tuple(x * K for x in p) for p in verts]
        self.f += [tuple(o + i for i in fc) for fc in faces]

    def make(self, name, mat, uv=None, flat=True):
        me = bpy.data.meshes.new(name)
        me.from_pydata(self.v, [], self.f)
        if uv:
            layer = me.uv_layers.new(name='UVMap')
            for lp in me.loops:
                layer.data[lp.index].uv = uv(me.vertices[lp.vertex_index].co / K)
        me.materials.append(mat)
        (me.shade_flat if flat else me.shade_smooth)()
        ob = bpy.data.objects.new(name, me)
        bpy.context.scene.collection.objects.link(ob)
        return ob


def ring(r, z, n, wobble=None):
    return [((r + (wobble(i) if wobble else 0)) * math.cos(TAU * i / n), (r + (wobble(i) if wobble else 0)) * math.sin(TAU * i / n), z) for i in range(n)]


def meadow():
    rnd = random.Random(11)
    n = 96
    top = Builder()
    rings = [ring(r, SOIL, n) for r in (5, 10, 16, 20)] + [ring(RADIUS, SOIL - 0.12, n)]
    verts = [(0, 0, SOIL)] + [p for r in rings for p in r]
    faces = [(0, 1 + i, 1 + (i + 1) % n) for i in range(n)]
    for k in range(len(rings) - 1):
        a, b = 1 + k * n, 1 + (k + 1) * n
        faces += [(a + i, b + i, b + (i + 1) % n, a + (i + 1) % n) for i in range(n)]
    top.add(verts, faces)
    top.make('ground', material('ground', (1, 1, 1), image=ground_image()), flat=False,
             uv=lambda c: (c.x / (2 * RADIUS) + .5, c.y / (2 * RADIUS) + .5))
    side = Builder()
    a, b = ring(RADIUS, SOIL - 0.12, n), ring(RADIUS - 1.2, 0, n)
    side.add(a + b, [(i, n + i, n + (i + 1) % n, (i + 1) % n) for i in range(n)] + [tuple(range(2 * n - 1, n - 1, -1))])
    side.make('soil', material('soil', (.16, .09, .045)))

    pond = Builder()
    wob = [rnd.uniform(-.35, .35) for _ in range(28)]
    pond.add([(0, 0, SOIL + .03)] + ring(3.9, SOIL + .03, 28, lambda i: wob[i]), [(0, 1 + i, 1 + (i + 1) % 28) for i in range(28)])
    pond.make('pond', material('pond', (.05, .2, .26), rough=.12))

    def spot(lo, hi):
        r, a = math.sqrt(rnd.uniform(lo * lo, hi * hi)), rnd.uniform(0, TAU)
        return r * math.cos(a), r * math.sin(a)

    # 양치식물 덤불. 티라노가 지나는 길(몸이 휩쓰는 폭)은 짧게, 나머지는 크게.
    ferns = [Builder(), Builder()]

    def fern(x, y, size, blades):
        b = rnd.choice(ferns)
        base = rnd.uniform(0, TAU)
        for j in range(blades):
            an = base + TAU * j / blades + rnd.uniform(-.25, .25)
            c, s = math.cos(an), math.sin(an)
            ln, hh, ww = size * rnd.uniform(.8, 1.15), size * rnd.uniform(.55, .85), size * .13
            b.add([(x - s * ww * .4, y + c * ww * .4, SOIL), (x + s * ww * .4, y - c * ww * .4, SOIL),
                   (x + c * ln * .55 + s * ww, y + s * ln * .55 - c * ww, SOIL + hh),
                   (x + c * ln * .55 - s * ww, y + s * ln * .55 + c * ww, SOIL + hh),
                   (x + c * ln, y + s * ln, SOIL + hh * .6)], [(0, 1, 2, 3), (3, 2, 4)])

    for _ in range(190):
        fern(*spot(18.2, 21.4), rnd.uniform(.4, 1.0), 6)
    for _ in range(130):
        fern(*spot(5.0, 9.6), rnd.uniform(.5, 1.2), 6)
    for _ in range(520):
        fern(*spot(9.6, 17.6), rnd.uniform(.16, .34), 4)
    for b, c in zip(ferns, ((.10, .24, .045), (.2, .33, .07))):
        ob = b.make('fern', material('fern', c, rough=.9))
        ob.data.materials[0].use_backface_culling = False

    rocks = Builder()
    for _ in range(26):
        x, y = spot(4.2, 5.6) if rnd.random() < .5 else spot(18, 21)
        size, seg = rnd.uniform(.3, .95), 7
        vs = [(x, y, SOIL + size * rnd.uniform(.55, .9))]
        for h, w in ((.45, .75), (-.1, 1.0)):
            vs += [(x + size * w * rnd.uniform(.75, 1.1) * math.cos(TAU * i / seg), y + size * w * rnd.uniform(.75, 1.1) * math.sin(TAU * i / seg), SOIL + size * h) for i in range(seg)]
        rocks.add(vs, [(0, 1 + i, 1 + (i + 1) % seg) for i in range(seg)] + [(1 + i, 1 + seg + i, 1 + seg + (i + 1) % seg, 1 + (i + 1) % seg) for i in range(seg)])
    rocks.make('rocks', material('rock', (.3, .28, .25)))

    trunk, leaves = Builder(), Builder()

    def cone(b, x, y, z0, z1, r0, r1, seg):
        vs = [(x + r0 * math.cos(TAU * i / seg), y + r0 * math.sin(TAU * i / seg), z0) for i in range(seg)]
        if r1:
            vs += [(x + r1 * math.cos(TAU * i / seg), y + r1 * math.sin(TAU * i / seg), z1) for i in range(seg)]
            b.add(vs, [(i, (i + 1) % seg, seg + (i + 1) % seg, seg + i) for i in range(seg)])
        else:
            b.add(vs + [(x, y, z1)], [(i, (i + 1) % seg, seg) for i in range(seg)] + [tuple(range(seg - 1, -1, -1))])

    for ang, r, h in ((12, 20.3, 9), (48, 20.3, 10), (64, 20.4, 7), (95, 20.2, 7.5), (112, 19.9, 10.5), (172, 20.2, 8.5), (135, 6.8, 7), (50, 7.2, 8)):
        x, y = r * math.cos(math.radians(ang)), r * math.sin(math.radians(ang))
        cone(trunk, x, y, SOIL - .1, SOIL + h * .75, .32, .12, 7)
        for j in range(5):
            z = SOIL + h * (.26 + .145 * j)
            cone(leaves, x, y, z, z + h * .27, 1.55 - .25 * j, 0, 9)
    trunk.make('trunk', material('trunk', (.13, .075, .04)))
    leaves.make('leaves', material('leaves', (.045, .14, .06)))


def add_shadow(arm):
    b = Builder()
    b.add([(-2.3, 4.6, .05), (-2.3, -5.6, .05), (2.3, -5.6, .05), (2.3, 4.6, .05)], [(0, 1, 2, 3)])
    ob = b.make('shadow', material('shadow', (0, 0, 0), image=shadow_image(), alpha=True),
                uv=lambda c: (c.x / 4.6 + .5, (c.y + .5) / 10.2 + .5))
    g = ob.vertex_groups.new(name='root')
    g.add(range(4), 1.0, 'REPLACE')
    ob.modifiers.new('Armature', 'ARMATURE').object = arm
    ob.parent = arm


# ---------- 검사 ----------
def verts_of(ob):
    e = ob.evaluated_get(bpy.context.evaluated_depsgraph_get())
    m = e.to_mesh()
    a = np.empty(len(m.vertices) * 3, np.float32)
    m.vertices.foreach_get('co', a)
    e.to_mesh_clear()
    w = np.array(e.matrix_world)
    return (a.reshape(-1, 3) @ w[:3, :3].T + w[:3, 3]) / K


def check(ob, gait, feet, label):
    """딛는 동안 앞발바닥이 제자리에 있는지, 땅을 뚫거나 뜨지 않는지 매 프레임 잰다."""
    sc = bpy.context.scene
    frames = {}
    for f in range(FRAMES + 1):
        sc.frame_set(f)
        frames[f] = verts_of(ob)
    slide = 0.0
    floors = []
    for n, (stances, ball) in feet.items():
        for a, b, s in stances:
            fs = [f for f in range(FRAMES + 1) if a <= f * SUB < b]
            if len(fs) < 2:
                continue
            c = on_path(s, ball)
            base = frames[fs[0]]
            near = (np.hypot(base[:, 0] - c.x, base[:, 1] - c.y) < .45) & (base[:, 2] < SOIL + .12)
            if not near.any():
                print('  경고: 발바닥 정점을 못 찾음', n, fs[0])
                continue
            for f in fs:
                slide = max(slide, float(np.hypot(*(frames[f][near] - base[near])[:, :2].T).max()))
                floors.append(float(frames[f][near][:, 2].min()) - SOIL)
    low = min(float(p[:, 2].min()) for p in frames.values()) - SOIL
    seam = float(np.linalg.norm(frames[0] - frames[FRAMES], axis=1).max())
    jump = max((float(np.linalg.norm(frames[f + 1] - frames[f], axis=1).max()), f) for f in range(FRAMES))
    reach = max(float(np.hypot(p[:, 0], p[:, 1]).max()) for p in frames.values())
    # 가장자리 길이 변화로 피부가 찢어지거나 뒤집힌 곳을 찾는다.
    edges = np.array([e.vertices[:] for e in ob.data.edges])
    rest = np.linalg.norm(frames[0][edges[:, 0]] - frames[0][edges[:, 1]], axis=1) + 1e-6
    stretch = max((float(np.percentile(np.linalg.norm(p[edges[:, 0]] - p[edges[:, 1]], axis=1) / rest, 99.9)), f) for f, p in frames.items())
    print(f'CHECK {label}(12m 기준) 디딘 발 미끄러짐 {slide:.3f} m, 디딘 발 높이 {min(floors):.3f}~{max(floors):.3f} m, '
          f'최저점 {low:.3f} m, 이음새 {seam:.4f} m, 프레임당 최대 이동 {jump[0]:.2f} m(f{jump[1]}), '
          f'몸이 닿는 최대 반지름 {reach:.1f}/{RADIUS} m, 늘어남 99.9% {stretch[0]:.2f}배(f{stretch[1]})')


def render(preview, gait):
    sc = bpy.context.scene
    sc.render.engine = 'BLENDER_WORKBENCH'
    sc.display.shading.color_type = 'TEXTURE'
    sc.display.shading.light = 'FLAT'
    sc.view_settings.view_transform = 'Standard'
    cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))
    cam.data.clip_start, cam.data.clip_end = .001, 10
    sc.collection.objects.link(cam)
    sc.camera = cam

    def shot(name, f, loc, aim, res=(640, 400), lens=40):
        sc.frame_set(f)
        sc.render.resolution_x, sc.render.resolution_y = res
        cam.data.lens = lens
        cam.location = Vector(loc) * K
        cam.rotation_euler = (Vector(aim) - Vector(loc)).to_track_quat('-Z', 'Y').to_euler()
        sc.render.filepath = os.path.join(preview, name)
        bpy.ops.render.render(write_still=True)

    shot('wide.png', 130, (30, -38, 30), (0, 0, 1), (1100, 760), 35)
    # 옆에서 따라가며 걷기와 뛰기 한 걸음을 찍는다. 다리가 보이게 식물은 숨긴다.
    for o in bpy.data.objects:
        if o.name.split('.')[0] in ('fern', 'leaves', 'trunk', 'rocks', 'pond', 'shadow'):
            o.hide_render = True
    for tag, f0, span in (('walk', 130, 26), ('run', 260, 16)):
        for j in range(8):
            f = f0 + round(span * j / 8)
            pos, yaw = heading(gait.dist(f * SUB))
            out = pos.normalized()
            c = pos + Vector((0, 0, SOIL + 2.2))
            ahead = Matrix.Rotation(yaw, 3, 'Z') @ Vector((0, -1, 0))
            shot(f'{tag}{j}.png', f, c + out * 17 + ahead * 6 + Vector((0, 0, 1.5)), c, (560, 330), 45)


def main():
    src, out_dir, preview = rig.parse_args()
    mesh, arm = rig.build(src, K)
    arm.data.bones['root'].use_deform = True
    gait, feet = animate(arm)
    check(mesh, gait, feet, '내보내기 전')
    add_shadow(arm)
    meadow()
    if preview:
        render(preview, gait)
    bpy.context.scene.frame_set(0)
    path = os.path.join(out_dir, 'trex-meadow.glb')
    rig.export(path)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.scene.render.fps = FPS
    bpy.ops.import_scene.gltf(filepath=path)
    skinned = [o for o in bpy.data.objects if o.type == 'MESH' and any(m.type == 'ARMATURE' for m in o.modifiers)]
    check(max(skinned, key=lambda o: len(o.data.vertices)), gait, feet, '배포본')
    print('TRIS', sum(len(p.vertices) - 2 for o in bpy.data.objects if o.type == 'MESH' for p in o.data.polygons),
          'MESHES', [o.name for o in bpy.data.objects if o.type == 'MESH'])


main()
