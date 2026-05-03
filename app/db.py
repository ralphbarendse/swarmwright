from __future__ import annotations

from contextlib import contextmanager
from typing import Generator

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker, Session


class Base(DeclarativeBase):
    """Shared declarative base — all models inherit from this."""
    pass


_engine = None
_SessionLocal = None


def init_db(database_url: str) -> None:
    """Initialise the engine and session factory from the given URL."""
    global _engine, _SessionLocal

    connect_args = {}
    if database_url.startswith("sqlite"):
        # Allow the same connection across threads (Flask + APScheduler)
        connect_args["check_same_thread"] = False

    _engine = create_engine(
        database_url,
        connect_args=connect_args,
        echo=False,
    )
    _SessionLocal = sessionmaker(bind=_engine, autocommit=False, autoflush=False)


def get_engine():
    if _engine is None:
        raise RuntimeError("Database not initialised. Call init_db() first.")
    return _engine


@contextmanager
def get_session() -> Generator[Session, None, None]:
    """Context-manager that yields a session and closes it when done.

    Usage:
        with get_session() as session:
            session.add(obj)
            session.commit()
    """
    if _SessionLocal is None:
        raise RuntimeError("Database not initialised. Call init_db() first.")
    session: Session = _SessionLocal()
    try:
        yield session
    finally:
        session.close()
