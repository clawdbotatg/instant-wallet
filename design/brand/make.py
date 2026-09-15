from PIL import Image
import os
from PIL import ImageChops
UP='/Users/clawd/clawd-harness/.clawd-harness-uploads/'
WALLET=UP+'paste-f99e1e9e-3C9694B1-3C6B-4812-8A3B-DF83B57934AF.jpg'
DEVICE=UP+'paste-8433bd25-BBDFA22D-E2FC-4894-84AF-304E8A22139F.jpg'
PUB='packages/nextjs/public/'; BR='design/brand/'
def white_to_alpha(img, tol=246):
    """Background -> alpha via flood fill from the corners (so the white wallet body stays opaque);
    inside the flooded region alpha = 255-min(rgb) (exact un-composite over white) so soft shadows and
    anti-aliased edges fade instead of leaving a halo."""
    from PIL import ImageDraw
    rgb=img.convert('RGB'); W,H=rgb.size
    r,g,b=rgb.split(); mn=ImageChops.darker(ImageChops.darker(r,g),b)
    bgmask=mn.point(lambda v: 255 if v>=tol else 0).convert('L')   # candidate background = light pixels
    flood=Image.new('L',(W,H),0); fp=flood.load(); bp=bgmask.load()
    # BFS flood from the four corners through light pixels
    from collections import deque
    q=deque([(0,0),(W-1,0),(0,H-1),(W-1,H-1)])
    for x,y in list(q): fp[x,y]=255
    while q:
        x,y=q.popleft()
        for nx,ny in ((x+1,y),(x-1,y),(x,y+1),(x,y-1)):
            if 0<=nx<W and 0<=ny<H and fp[nx,ny]==0 and bp[nx,ny]:
                fp[nx,ny]=255; q.append((nx,ny))
    # grow the flooded region by 2px so the anti-aliased rim gets the soft formula too
    from PIL import ImageFilter
    flood=flood.filter(ImageFilter.MaxFilter(3))
    px=rgb.load(); fl=flood.load(); mp=mn.load(); out=Image.new('RGBA',(W,H)); op=out.load()
    for y in range(H):
        for x in range(W):
            R,G,B=px[x,y]
            if not fl[x,y]: op[x,y]=(R,G,B,255); continue
            a=max(0,min(255,int((255-mp[x,y])*1.04-2)))
            if a<1: op[x,y]=(0,0,0,0); continue
            k=255-a
            op[x,y]=(max(0,min(255,(R-k)*255//a)),max(0,min(255,(G-k)*255//a)),max(0,min(255,(B-k)*255//a)),a)
    return out
def trim(img,pad=0):
    bb=img.split()[3].point(lambda v:255 if v>8 else 0).getbbox()
    l,t,r,b=bb; return img.crop((max(0,l-pad),max(0,t-pad),min(img.width,r+pad),min(img.height,b+pad)))
def fit(img,size):
    im=img.copy(); im.thumbnail((size,size),Image.LANCZOS); return im
def on_bg(mark,size,pad_frac,bg=(244,244,241,255)):
    canvas=Image.new('RGBA',(size,size),bg); inner=int(size*(1-2*pad_frac)); m=fit(mark,inner)
    canvas.alpha_composite(m,((size-m.width)//2,(size-m.height)//2)); return canvas.convert('RGB')
w=Image.open(WALLET); d=Image.open(DEVICE)
wa=white_to_alpha(w); da=white_to_alpha(d)
lockup=trim(wa,8); mark=trim(wa.crop((0,0,w.width,870)),8); word=trim(wa.crop((0,880,w.width,w.height)),8)
device=trim(da.crop((0,0,d.width,830)),8); device_lockup=trim(da,8)
fit(mark,1024).save(PUB+'mark.png'); fit(mark,160).save(PUB+'mark-160.png'); fit(lockup,1200).save(PUB+'logo.png'); fit(word,1200).save(PUB+'wordmark.png')
fit(device,1024).save(PUB+'device.png')
for n,im in [('wallet-lockup',lockup),('wallet-mark',mark),('wordmark',word),('device-mark',device),('device-lockup',device_lockup)]: im.save(BR+n+'.png')
on_bg(mark,192,0.06).save(PUB+'icons/icon-192.png'); on_bg(mark,512,0.06).save(PUB+'icons/icon-512.png')
on_bg(mark,180,0.08).save(PUB+'icons/apple-touch-icon.png')
on_bg(mark,192,0.18).save(PUB+'icons/maskable-192.png'); on_bg(mark,512,0.18).save(PUB+'icons/maskable-512.png')
for f in ['mark.png','logo.png','wordmark.png','device.png']: print(f, Image.open(PUB+f).size, os.path.getsize(PUB+f)//1024,'KB')
