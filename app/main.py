import base64
import hashlib
import hmac
import os
import re
import secrets
import threading
import uuid
from datetime import datetime, timedelta
from pathlib import Path

from fastapi import Cookie, Depends, FastAPI, File, Form, HTTPException, Response, UploadFile
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from jinja2 import Environment, FileSystemLoader, select_autoescape
from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text, create_engine, select
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./buu_nails.db")
if DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql+psycopg://", 1)
elif DATABASE_URL.startswith("postgresql://"):
    DATABASE_URL = DATABASE_URL.replace("postgresql://", "postgresql+psycopg://", 1)
engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {})
templates = Environment(loader=FileSystemLoader("app/templates"), autoescape=select_autoescape())
upload_dir = Path(os.getenv("UPLOAD_DIR", "uploads")); upload_dir.mkdir(parents=True, exist_ok=True)


class Base(DeclarativeBase): pass


class User(Base):
    __tablename__ = "users"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(100))
    phone: Mapped[str | None] = mapped_column(String(30), nullable=True)
    pin_hash: Mapped[str] = mapped_column(String(256))
    role: Mapped[str] = mapped_column(String(20), default="client")
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class AuthSession(Base):
    __tablename__ = "auth_sessions"
    token: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    expires_at: Mapped[datetime] = mapped_column(DateTime)


class Appointment(Base):
    __tablename__ = "appointments"
    id: Mapped[int] = mapped_column(primary_key=True)
    client_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    service: Mapped[str] = mapped_column(String(100))
    starts_at: Mapped[datetime] = mapped_column(DateTime, index=True)
    ends_at: Mapped[datetime] = mapped_column(DateTime, index=True)
    status: Mapped[str] = mapped_column(String(20), default="scheduled")
    price_cents: Mapped[int] = mapped_column(Integer, default=0)
    recurring_group: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class AgendaBlock(Base):
    __tablename__ = "agenda_blocks"
    id: Mapped[int] = mapped_column(primary_key=True)
    starts_at: Mapped[datetime] = mapped_column(DateTime, index=True)
    ends_at: Mapped[datetime] = mapped_column(DateTime, index=True)
    note: Mapped[str | None] = mapped_column(String(160), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class Payment(Base):
    __tablename__ = "payments"
    id: Mapped[int] = mapped_column(primary_key=True)
    appointment_id: Mapped[int] = mapped_column(ForeignKey("appointments.id"), unique=True)
    amount_cents: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(20), default="pending")
    proof_path: Mapped[str | None] = mapped_column(String(300), nullable=True)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    submitted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    confirmed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class AppSetting(Base):
    __tablename__ = "app_settings"
    key: Mapped[str] = mapped_column(String(80), primary_key=True)
    value: Mapped[str] = mapped_column(Text)


def db_session():
    with Session(engine) as db:
        yield db


def hash_pin(pin: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt((os.getenv("SECRET_KEY", "mude-esta-chave") + pin).encode(), salt=salt, n=2**14, r=8, p=1)
    return "scrypt$" + base64.urlsafe_b64encode(salt).decode() + "$" + base64.urlsafe_b64encode(digest).decode()


def verify_pin(stored: str, pin: str) -> bool:
    try:
        _, salt_text, digest_text = stored.split("$", 2)
        digest = hashlib.scrypt((os.getenv("SECRET_KEY", "mude-esta-chave") + pin).encode(), salt=base64.urlsafe_b64decode(salt_text), n=2**14, r=8, p=1)
        return hmac.compare_digest(base64.urlsafe_b64encode(digest).decode(), digest_text)
    except (ValueError, TypeError):
        return False


def normalized(value: str | None) -> str:
    return re.sub(r"[^a-z0-9]", "", (value or "").casefold())


def setting(db: Session, key: str, default: str) -> str:
    row = db.get(AppSetting, key)
    if not row:
        db.add(AppSetting(key=key, value=default)); db.flush()
        return default
    return row.value


def set_setting(db: Session, key: str, value: str) -> None:
    row = db.get(AppSetting, key)
    if row: row.value = value
    else: db.add(AppSetting(key=key, value=value))


def current_user(session_token: str | None = Cookie(None), db: Session = Depends(db_session)) -> User:
    auth = db.get(AuthSession, session_token) if session_token else None
    if not auth or auth.expires_at < datetime.utcnow(): raise HTTPException(401, "Entre como administradora para continuar.")
    user = db.get(User, auth.user_id)
    if not user or user.role not in {"admin", "tester"} or not user.active: raise HTTPException(403, "Acesso não autorizado.")
    return user


def current_admin(user: User = Depends(current_user)) -> User:
    if user.role != "admin": raise HTTPException(403, "Acesso exclusivo da Bruna.")
    return user


def overlap(db: Session, start: datetime, end: datetime) -> bool:
    return db.scalar(select(Appointment).where(Appointment.status.in_(("scheduled", "rescheduled")), Appointment.starts_at < end, Appointment.ends_at > start)) is not None


def blocked(db: Session, start: datetime, end: datetime) -> bool:
    return db.scalar(select(AgendaBlock).where(AgendaBlock.starts_at < end, AgendaBlock.ends_at > start)) is not None


def unavailable(db: Session, start: datetime, end: datetime) -> bool:
    return overlap(db, start, end) or blocked(db, start, end)


def payment_for(db: Session, appointment_id: int) -> Payment:
    item = db.scalar(select(Payment).where(Payment.appointment_id == appointment_id))
    if not item: raise HTTPException(404, "Pagamento não encontrado.")
    return item


def appointment_json(item: Appointment, db: Session) -> dict:
    client = db.get(User, item.client_id); payment = payment_for(db, item.id)
    return {"id": item.id, "code": f"BN-{item.id:05d}", "client": client.name, "phone": client.phone or "",
            "service": item.service, "starts_at": item.starts_at.isoformat(), "ends_at": item.ends_at.isoformat(),
            "status": item.status, "price_cents": item.price_cents, "recurring": bool(item.recurring_group),
            "payment": {"status": payment.status, "amount_cents": payment.amount_cents, "proof": bool(payment.proof_path)}}


app = FastAPI(title="Buu Nails")
app.mount("/static", StaticFiles(directory="app/static"), name="static")
RELEASE = {"version": "1.0.7", "type": "feature", "title": "Agenda simplificada e perfil de teste",
           "description": "Duração removida da interface e perfil auleonadmin isolado para testes."}
reservation_lock = threading.Lock()


@app.on_event("startup")
def setup():
    Base.metadata.create_all(engine)
    with Session(engine) as db:
        administrator = db.scalar(select(User).where(User.role == "admin"))
        if not administrator:
            administrator = User(name="Manicure Bruna", role="admin", pin_hash=hash_pin("mudar123")); db.add(administrator); db.flush()
        tester = db.scalar(select(User).where(User.role == "tester"))
        if not tester:
            tester = User(name="auleonadmin", role="tester", pin_hash=hash_pin("mudar123")); db.add(tester); db.flush()
        if setting(db, "bruna_password_changed", "false") == "false": administrator.pin_hash = hash_pin("mudar123")
        if setting(db, "tester_password_changed", "false") == "false": tester.pin_hash = hash_pin("mudar123")
        setting(db, "default_price_cents", "8000")
        setting(db, "default_duration", "60")
        db.commit()


@app.get("/", response_class=HTMLResponse)
def home():
    page = templates.get_template("index.html").render()
    page = page.replace('src="/static/brand-logo.png"', 'src="/static/brand-logo-optimized.png"')
    page = page.replace('href="/static/brand-logo.png"', 'href="/apple-touch-icon.png"')
    page = page.replace('src="/static/app.js"', 'src="/static/app.js?v=1.0.7"')
    page = page.replace('<h1>Buu Nails</h1>', '<h1 class="brand-title">Bruna S <small>Nails</small></h1>')
    page = page.replace('<label>Senha administrativa', '<label>Usuário<input id="admin-username" required value="Manicure Bruna" autocomplete="username"></label><label>Senha administrativa')
    page = page.replace('<h2>Preço e duração</h2>', '<h2>Valor da unha</h2>')
    page = re.sub(r'<label>Duração<select id="booking-duration".*?</select></label>', '', page)
    page = re.sub(r'<label>Duração<select id="default-duration".*?</select></label>', '', page)
    return page


@app.get("/apple-touch-icon.png", include_in_schema=False)
@app.get("/apple-touch-icon-precomposed.png", include_in_schema=False)
def apple_touch_icon():
    return FileResponse("app/static/brand-logo-optimized.png", media_type="image/png",
                        headers={"Cache-Control": "public, max-age=31536000, immutable"})


@app.get("/favicon.ico", include_in_schema=False)
def favicon():
    return FileResponse("app/static/icon.svg", media_type="image/svg+xml",
                        headers={"Cache-Control": "public, max-age=31536000, immutable"})


@app.get("/healthz")
def health(): return {"status": "ok"}


@app.get("/api/public/config")
def public_config(db: Session = Depends(db_session)):
    return {"price_cents": int(setting(db, "default_price_cents", "8000")), "duration": int(setting(db, "default_duration", "60"))}


@app.get("/api/public/release")
def release():
    import json
    return Response(content=json.dumps(RELEASE), media_type="application/json",
                    headers={"Cache-Control": "no-store, no-cache, must-revalidate"})


@app.get("/api/public/busy")
def busy(from_date: str, to_date: str, db: Session = Depends(db_session)):
    start, end = datetime.fromisoformat(from_date), datetime.fromisoformat(to_date) + timedelta(days=1)
    rows = db.scalars(select(Appointment).where(Appointment.status.in_(("scheduled", "rescheduled")), Appointment.starts_at >= start, Appointment.starts_at < end).order_by(Appointment.starts_at)).all()
    blocks = db.scalars(select(AgendaBlock).where(AgendaBlock.starts_at < end, AgendaBlock.ends_at > start).order_by(AgendaBlock.starts_at)).all()
    return [{"starts_at": row.starts_at.isoformat(), "ends_at": row.ends_at.isoformat()} for row in rows] + [{"starts_at": row.starts_at.isoformat(), "ends_at": row.ends_at.isoformat()} for row in blocks]


@app.get("/api/public/availability")
def availability(date: str, duration: int | None = None, db: Session = Depends(db_session)):
    day = datetime.fromisoformat(date).replace(hour=0, minute=0, second=0, microsecond=0)
    minutes = max(30, min(240, duration or int(setting(db, "default_duration", "60"))))
    day_end = day + timedelta(days=1)
    busy_rows = db.scalars(select(Appointment).where(Appointment.status.in_(("scheduled", "rescheduled")), Appointment.starts_at < day_end, Appointment.ends_at > day)).all()
    blocked_rows = db.scalars(select(AgendaBlock).where(AgendaBlock.starts_at < day_end, AgendaBlock.ends_at > day)).all()
    slots = []
    cursor, closes = day.replace(hour=9), day.replace(hour=19)
    while cursor + timedelta(minutes=minutes) <= closes:
        end = cursor + timedelta(minutes=minutes)
        if not any(item.starts_at < end and item.ends_at > cursor for item in busy_rows) and not any(item.starts_at < end and item.ends_at > cursor for item in blocked_rows):
            slots.append(cursor.strftime("%H:%M"))
        cursor += timedelta(minutes=15)
    return {"date": date, "duration": minutes, "available": slots,
            "reserved": [{"starts_at": row.starts_at.isoformat(), "ends_at": row.ends_at.isoformat()} for row in busy_rows] + [{"starts_at": row.starts_at.isoformat(), "ends_at": row.ends_at.isoformat()} for row in blocked_rows]}


@app.post("/api/public/reservations")
def public_reservation(data: dict, db: Session = Depends(db_session)):
    name = str(data.get("name", "")).strip()
    phone = str(data.get("phone", "")).strip() or None
    if not name: raise HTTPException(422, "Seu nome ou apelido é obrigatório.")
    try: start = datetime.fromisoformat(str(data["starts_at"]))
    except (KeyError, ValueError): raise HTTPException(422, "Informe uma data e horário válidos.")
    minutes = max(30, min(240, int(data.get("duration", setting(db, "default_duration", "60")))))
    end = start + timedelta(minutes=minutes)
    if start < datetime.now() - timedelta(minutes=1): raise HTTPException(422, "Escolha um horário futuro.")
    with reservation_lock:
        if unavailable(db, start, end): raise HTTPException(409, "Este horário não está disponível. Escolha outro horário.")
        client = db.scalar(select(User).where(User.role == "client", User.name == name, User.phone == phone)) if phone else db.scalar(select(User).where(User.role == "client", User.name == name, User.phone.is_(None)))
        if not client:
            client = User(name=name, phone=phone, pin_hash=hash_pin(secrets.token_urlsafe(20)), role="client"); db.add(client); db.flush()
        price = int(setting(db, "default_price_cents", "8000"))
        appointment = Appointment(client_id=client.id, service=str(data.get("service", "Atendimento Buu Nails"))[:100], starts_at=start, ends_at=end, price_cents=price)
        db.add(appointment); db.flush(); db.add(Payment(appointment_id=appointment.id, amount_cents=price)); db.commit()
    return {"code": f"BN-{appointment.id:05d}", "appointment_id": appointment.id, "price_cents": price, "starts_at": start.isoformat()}


def checked_upload(file: UploadFile) -> tuple[bytes, str]:
    allowed = {"image/jpeg": (b"\xff\xd8\xff", ".jpg"), "image/png": (b"\x89PNG\r\n\x1a\n", ".png"), "image/webp": (b"RIFF", ".webp")}
    if file.content_type not in allowed: raise HTTPException(422, "Envie uma imagem JPG, PNG ou WebP.")
    content = file.file.read()
    if not content or len(content) > 5_000_000: raise HTTPException(422, "O comprovante deve ter no máximo 5 MB.")
    signature, suffix = allowed[file.content_type]
    if not content.startswith(signature) or (file.content_type == "image/webp" and content[8:12] != b"WEBP"): raise HTTPException(422, "O arquivo enviado não é uma imagem válida.")
    return content, suffix


@app.post("/api/public/payment-proof")
async def public_payment_proof(code: str = Form(...), name: str = Form(...), phone: str = Form(""), file: UploadFile = File(...), db: Session = Depends(db_session)):
    match = re.fullmatch(r"BN-(\d{1,12})", code.strip().upper())
    if not match or not name.strip(): raise HTTPException(422, "Informe o código da reserva e o nome usado no agendamento.")
    appointment = db.get(Appointment, int(match.group(1)))
    if not appointment or appointment.status != "scheduled": raise HTTPException(404, "Reserva não encontrada.")
    client = db.get(User, appointment.client_id)
    same_name = normalized(name) == normalized(client.name)
    same_phone = bool(phone.strip() and normalized(phone) == normalized(client.phone))
    if not (same_name or same_phone): raise HTTPException(403, "Os dados não correspondem à reserva. Use o mesmo nome/apelido ou telefone.")
    content, suffix = checked_upload(file)
    filename = f"{uuid.uuid4()}{suffix}"; (upload_dir / filename).write_bytes(content)
    payment = payment_for(db, appointment.id); payment.proof_path = filename; payment.status = "submitted"; payment.submitted_at = datetime.utcnow(); db.commit()
    return {"ok": True, "message": "Comprovante enviado para análise da Bruna."}


@app.post("/api/admin/login")
def admin_login(data: dict, response: Response, db: Session = Depends(db_session)):
    username = normalized(str(data.get("username", "Manicure Bruna")))
    user = next((item for item in db.scalars(select(User).where(User.role.in_(("admin", "tester")))).all() if normalized(item.name) == username), None)
    if not user or not verify_pin(user.pin_hash, str(data.get("password", ""))): raise HTTPException(401, "Usuário ou senha incorretos.")
    token = secrets.token_urlsafe(32); db.add(AuthSession(token=token, user_id=user.id, expires_at=datetime.utcnow() + timedelta(days=45))); db.commit()
    response.set_cookie("session_token", token, httponly=True, samesite="lax", secure=os.getenv("COOKIE_SECURE") == "true", max_age=3888000)
    key = "bruna_password_changed" if user.role == "admin" else "tester_password_changed"
    return {"name": user.name, "role": user.role, "must_change_password": setting(db, key, "false") == "false"}


@app.post("/api/admin/logout")
def admin_logout(response: Response, session_token: str | None = Cookie(None), db: Session = Depends(db_session)):
    item = db.get(AuthSession, session_token) if session_token else None
    if item: db.delete(item); db.commit()
    response.delete_cookie("session_token"); return {"ok": True}


@app.post("/api/admin/password")
def change_password(data: dict, admin: User = Depends(current_user), db: Session = Depends(db_session)):
    password = str(data.get("password", ""))
    if len(password) < 8: raise HTTPException(422, "A nova senha precisa ter ao menos 8 caracteres.")
    admin.pin_hash = hash_pin(password); set_setting(db, "bruna_password_changed" if admin.role == "admin" else "tester_password_changed", "true"); db.commit()
    return {"ok": True}


@app.get("/api/admin/appointments")
def admin_appointments(admin: User = Depends(current_admin), db: Session = Depends(db_session)):
    rows = db.scalars(select(Appointment).order_by(Appointment.starts_at)).all()
    return [appointment_json(row, db) for row in rows]


@app.get("/api/admin/blocks")
def admin_blocks(admin: User = Depends(current_admin), db: Session = Depends(db_session)):
    rows = db.scalars(select(AgendaBlock).order_by(AgendaBlock.starts_at)).all()
    return [{"id": row.id, "starts_at": row.starts_at.isoformat(), "ends_at": row.ends_at.isoformat(), "note": row.note or "Agenda indisponível"} for row in rows]


@app.post("/api/admin/blocks")
def create_block(data: dict, admin: User = Depends(current_admin), db: Session = Depends(db_session)):
    try:
        start, end = datetime.fromisoformat(str(data["starts_at"])), datetime.fromisoformat(str(data["ends_at"]))
    except (KeyError, ValueError): raise HTTPException(422, "Informe início e fim do bloqueio.")
    if end <= start: raise HTTPException(422, "O fim precisa ser depois do início.")
    with reservation_lock:
        if overlap(db, start, end): raise HTTPException(409, "Existe uma reserva nesse período. Altere ou cancele a reserva antes de bloquear.")
        item = AgendaBlock(starts_at=start, ends_at=end, note=str(data.get("note", ""))[:160] or None)
        db.add(item); db.commit(); db.refresh(item)
    return {"id": item.id, "starts_at": item.starts_at.isoformat(), "ends_at": item.ends_at.isoformat(), "note": item.note or "Agenda indisponível"}


@app.delete("/api/admin/blocks/{block_id}")
def remove_block(block_id: int, admin: User = Depends(current_admin), db: Session = Depends(db_session)):
    item = db.get(AgendaBlock, block_id)
    if not item: raise HTTPException(404, "Bloqueio não encontrado.")
    db.delete(item); db.commit()
    return Response(status_code=204)


@app.get("/api/admin/dashboard")
def dashboard(admin: User = Depends(current_admin), db: Session = Depends(db_session)):
    rows = db.scalars(select(Appointment).where(Appointment.status != "cancelled")).all()
    now = datetime.now(); day_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    week_start = day_start - timedelta(days=day_start.weekday()); month_start = day_start.replace(day=1)
    payments = [payment_for(db, row.id) for row in rows]
    return {"today": sum(1 for r in rows if r.starts_at >= day_start and r.starts_at < day_start + timedelta(days=1)),
            "week": sum(1 for r in rows if r.starts_at >= week_start and r.starts_at < week_start + timedelta(days=7)),
            "month": sum(1 for r in rows if r.starts_at >= month_start and r.starts_at < (month_start + timedelta(days=32)).replace(day=1)),
            "received_cents": sum(p.amount_cents for p in payments if p.status == "paid"),
            "pending_cents": sum(p.amount_cents for p in payments if p.status != "paid"),
            "submitted": sum(1 for p in payments if p.status == "submitted"),
            "completed": sum(1 for r in rows if r.status == "completed"),
            "cancelled": sum(1 for r in db.scalars(select(Appointment).where(Appointment.status == "cancelled")).all()),
            "price_cents": int(setting(db, "default_price_cents", "8000")),
            "duration": int(setting(db, "default_duration", "60"))}


@app.put("/api/admin/pricing")
def pricing(data: dict, admin: User = Depends(current_admin), db: Session = Depends(db_session)):
    price = int(data.get("price_cents", 0))
    if price < 0: raise HTTPException(422, "Informe um preço válido.")
    set_setting(db, "default_price_cents", str(price)); set_setting(db, "default_duration", "60"); db.commit()
    return {"ok": True}


@app.post("/api/admin/manual-entry")
def manual_entry(data: dict, admin: User = Depends(current_admin), db: Session = Depends(db_session)):
    name = str(data.get("name", "")).strip()
    if not name: raise HTTPException(422, "Informe o nome ou apelido da cliente.")
    try: start = datetime.fromisoformat(str(data["starts_at"]))
    except (KeyError, ValueError): raise HTTPException(422, "Informe data e horário válidos.")
    minutes = max(30, min(240, int(data.get("duration", 60))))
    end = start + timedelta(minutes=minutes)
    with reservation_lock:
        if unavailable(db, start, end): raise HTTPException(409, "Já existe uma reserva ou bloqueio neste período.")
        phone = str(data.get("phone", "")).strip() or None
        client = db.scalar(select(User).where(User.role == "client", User.name == name, User.phone == phone)) if phone else None
        if not client:
            client = User(name=name, phone=phone, pin_hash=hash_pin(secrets.token_urlsafe(20)), role="client"); db.add(client); db.flush()
        price = max(0, int(data.get("price_cents", setting(db, "default_price_cents", "8000"))))
        appointment = Appointment(client_id=client.id, service=str(data.get("service", "Atendimento Buu Nails"))[:100], starts_at=start, ends_at=end, price_cents=price)
        db.add(appointment); db.flush()
        payment = Payment(appointment_id=appointment.id, amount_cents=price, status="paid" if data.get("paid") else "pending")
        if payment.status == "paid": payment.confirmed_at = datetime.utcnow()
        db.add(payment); db.commit()
    return appointment_json(appointment, db)


@app.put("/api/admin/appointments/{appointment_id}")
def update_appointment(appointment_id: int, data: dict, admin: User = Depends(current_admin), db: Session = Depends(db_session)):
    appointment = db.get(Appointment, appointment_id)
    if not appointment or appointment.status == "cancelled": raise HTTPException(404, "Reserva não encontrada.")
    name = str(data.get("name", "")).strip()
    if not name: raise HTTPException(422, "Informe o nome ou apelido da cliente.")
    try: start = datetime.fromisoformat(str(data["starts_at"]))
    except (KeyError, ValueError): raise HTTPException(422, "Informe data e horário válidos.")
    minutes = max(30, min(240, int(data.get("duration", 60))))
    end = start + timedelta(minutes=minutes)
    with reservation_lock:
        conflict = db.scalar(select(Appointment).where(Appointment.id != appointment.id, Appointment.status.in_(("scheduled", "rescheduled")), Appointment.starts_at < end, Appointment.ends_at > start))
        if conflict: raise HTTPException(409, "Já existe uma reserva neste período.")
        client = db.get(User, appointment.client_id)
        client.name = name; client.phone = str(data.get("phone", "")).strip() or None
        appointment.service = str(data.get("service", "Atendimento Buu Nails"))[:100]
        appointment.starts_at = start; appointment.ends_at = end; appointment.status = "rescheduled"
        appointment.price_cents = max(0, int(data.get("price_cents", appointment.price_cents)))
        payment = payment_for(db, appointment.id)
        payment.amount_cents = appointment.price_cents
        if "paid" in data:
            payment.status = "paid" if data.get("paid") else "pending"
            payment.confirmed_at = datetime.utcnow() if payment.status == "paid" else None
        db.commit()
    return appointment_json(appointment, db)


@app.post("/api/admin/appointments/{appointment_id}/status")
def appointment_status(appointment_id: int, data: dict, admin: User = Depends(current_admin), db: Session = Depends(db_session)):
    appointment = db.get(Appointment, appointment_id)
    status = str(data.get("status", ""))
    if not appointment or status not in {"scheduled", "completed", "cancelled"}: raise HTTPException(422, "Status de atendimento inválido.")
    appointment.status = status; db.commit()
    return appointment_json(appointment, db)


@app.post("/api/admin/payments/{appointment_id}/confirm")
def confirm(appointment_id: int, data: dict, admin: User = Depends(current_admin), db: Session = Depends(db_session)):
    payment = payment_for(db, appointment_id); payment.status = "paid" if data.get("paid", True) else "pending"; payment.confirmed_at = datetime.utcnow() if payment.status == "paid" else None; db.commit()
    return {"ok": True}


@app.get("/api/admin/payments/{appointment_id}/proof")
def proof(appointment_id: int, admin: User = Depends(current_admin), db: Session = Depends(db_session)):
    payment = payment_for(db, appointment_id); path = upload_dir / payment.proof_path if payment.proof_path else None
    if not path or not path.is_file(): raise HTTPException(404, "Comprovante não encontrado.")
    media = {".jpg": "image/jpeg", ".png": "image/png", ".webp": "image/webp"}.get(path.suffix, "application/octet-stream")
    return FileResponse(path, media_type=media, headers={"Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff"})
