#!/usr/bin/env bash
# 미국 국립공원청(NPS) 공공 저작물 녹음을 낮추고 겹쳐 공룡 울음소리를 만든다.
# 실제 공룡의 소리는 알 수 없으므로 동물 소리로 상상한 것이다.
# 사용: scripts/make-sounds.sh <원본 wav 폴더(32kHz 모노)> <출력 폴더>
set -euo pipefail
W=$1; O=$2; mkdir -p "$O"
# cut 이름 시작 길이 높이배율 → 자르고 잡음 줄이고 높이를 낮춘다(낮추면 길어진다)
cut() { ffmpeg -v error -y -ss "$2" -t "$3" -i "$W/$1.wav" -af "highpass=f=50,afftdn=nr=14:nf=-38,asetrate=32000*$4,aresample=32000,afade=t=in:d=0.06,areverse,afade=t=in:d=0.35,areverse" -c:a pcm_s16le "$5"; }
finish() { # 필터 결과를 크기 맞춰 저장
  ffmpeg -v error -y "${@:3}" -filter_complex "$2,silenceremove=start_periods=1:start_threshold=-45dB,acompressor=threshold=0.12:ratio=3:attack=8:release=180,loudnorm=I=-13:TP=-1.2:LRA=7,alimiter=limit=0.9,aresample=32000[o]" -map "[o]" -ac 1 -c:a libmp3lame -b:a 80k -map_metadata -1 "$O/$1.mp3"; }
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
tail_fade() { echo "afade=t=out:st=$1:d=$2"; }
# 티라노: 그리즐리 포효 + 악어 저음 + 곰 으르렁
cut griz 26.2 2.9 0.66 "$T/a.wav"; cut gator 15.0 2.6 0.62 "$T/b.wav"; cut grizvoc 66.0 2.6 0.60 "$T/c.wav"
finish trex "[0]volume=1.6,bass=g=7:f=110[a];[1]volume=0.9,lowpass=f=700[b];[2]volume=0.35,lowpass=f=2600[c];[a][b][c]amix=3:normalize=0:duration=longest,atrim=0:4.3,$(tail_fade 3.2 1.1)" -i "$T/a.wav" -i "$T/b.wav" -i "$T/c.wav"
# 트리케라톱스: 들소 울음 + 악어
cut bisonrut 44.0 2.0 0.72 "$T/a.wav"; cut gator 8.7 2.2 0.95 "$T/b.wav"
finish triceratops "[0]volume=3,bass=g=5:f=130[a];[1]volume=0.7[b];[a][b]amix=2:normalize=0:duration=longest,atrim=0:2.7,$(tail_fade 2.0 0.7)" -i "$T/a.wav" -i "$T/b.wav"
# 브라키오: 엘크 울음을 아주 낮게 + 혹등고래
cut elk2 2.0 3.0 0.36 "$T/a.wav"; cut whale 0.5 3.0 0.6 "$T/b.wav"
finish brachiosaurus "[0]volume=2,lowpass=f=2200,bass=g=5:f=120[a];[1]volume=0.5,lowpass=f=1200[b];[a][b]amix=2:normalize=0:duration=longest,atrim=0:5.0,$(tail_fade 3.6 1.4)" -i "$T/a.wav" -i "$T/b.wav"
# 스테고: 곰 소리를 짧고 탁하게 + 악어
cut griz 48.0 2.4 0.82 "$T/a.wav"; cut gator 15.2 2.0 1.05 "$T/b.wav"
finish stegosaurus "[0]volume=1.6,lowpass=f=1600[a];[1]volume=0.6[b];[a][b]amix=2:normalize=0:duration=longest,atrim=0:2.6,$(tail_fade 1.8 0.8)" -i "$T/a.wav" -i "$T/b.wav"
# 프테라노돈: 캐나다두루미
cut crane2 9.0 2.1 0.78 "$T/a.wav"
finish pteranodon "[0]volume=2,highpass=f=250,atrim=0:2.6,$(tail_fade 2.1 0.5)" -i "$T/a.wav"
