#define _GNU_SOURCE
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>
#include <wayland-client.h>
#include <xkbcommon/xkbcommon.h>
#include "virtual-keyboard-client-protocol.h"
#include "virtual-pointer-client-protocol.h"

static struct wl_seat *seat;
static struct zwp_virtual_keyboard_manager_v1 *manager;
static struct zwlr_virtual_pointer_manager_v1 *pointer_manager;

static void global(void *data, struct wl_registry *registry, uint32_t name,
                   const char *interface, uint32_t version) {
    (void)data;
    (void)version;
    if (strcmp(interface, wl_seat_interface.name) == 0 && !seat)
        seat = wl_registry_bind(registry, name, &wl_seat_interface, 1);
    if (strcmp(interface, zwp_virtual_keyboard_manager_v1_interface.name) == 0)
        manager = wl_registry_bind(registry, name, &zwp_virtual_keyboard_manager_v1_interface, 1);
    if (strcmp(interface, zwlr_virtual_pointer_manager_v1_interface.name) == 0)
        pointer_manager = wl_registry_bind(registry, name, &zwlr_virtual_pointer_manager_v1_interface, 1);
}

static void global_remove(void *data, struct wl_registry *registry, uint32_t name) {
    (void)data;
    (void)registry;
    (void)name;
}

static const struct wl_registry_listener registry_listener = { global, global_remove };

static int fail(const char *message) {
    fprintf(stderr, "octo-seat-input: %s\n", message);
    return 1;
}

int main(void) {
    struct wl_display *display = wl_display_connect(NULL);
    if (!display) return fail("could not connect to Wayland");
    struct wl_registry *registry = wl_display_get_registry(display);
    wl_registry_add_listener(registry, &registry_listener, NULL);
    if (wl_display_roundtrip(display) < 0 || !seat || !manager || !pointer_manager)
        return fail("Wayland seat or virtual input protocols unavailable");

    struct xkb_context *context = xkb_context_new(XKB_CONTEXT_NO_FLAGS);
    if (!context) return fail("could not create XKB context");
    struct xkb_keymap *keymap = xkb_keymap_new_from_names(context, NULL, XKB_KEYMAP_COMPILE_NO_FLAGS);
    if (!keymap) return fail("could not create keyboard map");
    char *text = xkb_keymap_get_as_string(keymap, XKB_KEYMAP_FORMAT_TEXT_V1);
    if (!text) return fail("could not serialize keyboard map");
    size_t size = strlen(text) + 1;
    int fd = memfd_create("octogee-seat-keyboard", MFD_CLOEXEC);
    if (fd < 0 || ftruncate(fd, (off_t)size) < 0) return fail("could not allocate keyboard map");
    void *mapped = mmap(NULL, size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    if (mapped == MAP_FAILED) return fail("could not map keyboard map");
    memcpy(mapped, text, size);
    munmap(mapped, size);
    free(text);
    xkb_keymap_unref(keymap);
    xkb_context_unref(context);

    zwlr_virtual_pointer_manager_v1_create_virtual_pointer(pointer_manager, seat);
    struct zwp_virtual_keyboard_v1 *keyboard = zwp_virtual_keyboard_manager_v1_create_virtual_keyboard(manager, seat);
    zwp_virtual_keyboard_v1_keymap(keyboard, WL_KEYBOARD_KEYMAP_FORMAT_XKB_V1, fd, (uint32_t)size);
    close(fd);
    if (wl_display_roundtrip(display) < 0) return fail("compositor rejected keyboard");
    puts("ready");
    fflush(stdout);
    while (wl_display_dispatch(display) >= 0) {}
    return fail(strerror(errno));
}
