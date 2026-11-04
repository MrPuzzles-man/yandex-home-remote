"""Compatibility fixes for the pinned Music Assistant runtime.

Music Assistant 2.10 stores setup-flow credentials in encrypted ``setup_data``.
The current Yandex Station borrow helper still reads the old public config
``values`` collection, so it incorrectly reports that a configured Yandex
Music provider has no credentials.  Keep the provider as the single owner of
the tokens, but read them through the setup-data API introduced by MA 2.10.
"""

from music_assistant_models.errors import LoginFailed
from ya_passport_auth import SecretStr
from ya_passport_auth.ma.borrow import BorrowedCredentialSource


def _secret(value: object) -> SecretStr | None:
    if isinstance(value, SecretStr):
        return value if value.get_secret() else None
    return SecretStr(str(value)) if value else None


def _read_tokens_from_setup_data(
    self: BorrowedCredentialSource,
) -> tuple[SecretStr | None, SecretStr | None]:
    # setup_data can be read before the owner provider finishes loading.  This
    # also removes the startup-order race where Yandex Station starts first.
    get_setup_value = getattr(self._mass.config, "get_provider_setup_value", None)  # noqa: SLF001
    if not callable(get_setup_value):
        raise LoginFailed("Music Assistant has no provider setup-data API.")

    return (
        _secret(get_setup_value(self.instance_id, self._music_token_key)),  # noqa: SLF001
        _secret(get_setup_value(self.instance_id, self._x_token_key)),  # noqa: SLF001
    )


BorrowedCredentialSource.read_tokens = _read_tokens_from_setup_data
