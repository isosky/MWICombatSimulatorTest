const GAME_TRANSLATIONS_URL = "js/i18n.json";

document.addEventListener("DOMContentLoaded", async function () {
    const resources = await loadTranslations();

    i18next
        .use(i18nextBrowserLanguageDetector)
        .init({
            resources,
            supportedLngs: ["zh", "en"],
            fallbackLng: "en",
            debug: false,
            ns: ["translation", "common"],
            defaultNS: "translation",
            interpolation: {
                escapeValue: false,
            },
            detection: {
                order: ["querystring", "localStorage", "navigator"],
                lookupQuerystring: "lng",
                lookupLocalStorage: "i18nextLng",
                caches: ["localStorage"],
            },
        })
        .then(function () {
            updateContent();
            addLanguageSwitcher();
        })
        .catch(showTranslationError);
});

async function loadTranslations() {
    try {
        const [gameResources, enCommon, zhCommon] = await Promise.all([
            fetchJson(GAME_TRANSLATIONS_URL),
            fetchJson("locales/en/common.json"),
            fetchJson("locales/zh/common.json"),
        ]);

        if (!gameResources.en?.translation || !gameResources.zh?.translation) {
            throw new Error("Expected en.translation and zh.translation resources.");
        }

        return {
            en: {
                translation: mergeResources(enCommon, gameResources.en.translation),
                common: enCommon,
            },
            zh: {
                translation: mergeResources(zhCommon, gameResources.zh.translation),
                common: zhCommon,
            },
        };
    } catch (error) {
        showTranslationError(error);
        return {};
    }
}

function mergeResources(base, overrides) {
    const merged = { ...base };

    for (const [key, value] of Object.entries(overrides)) {
        const baseValue = merged[key];
        merged[key] = isObject(baseValue) && isObject(value)
            ? mergeResources(baseValue, value)
            : value;
    }

    return merged;
}

function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function fetchJson(url) {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`${url}: HTTP ${response.status} ${response.statusText}`);
    }
    return response.json();
}

function showTranslationError(error) {
    console.error(`Unable to load game translations from ${GAME_TRANSLATIONS_URL}.`, error);

    const notice = document.createElement("div");
    notice.className = "alert alert-danger position-fixed top-0 start-50 translate-middle-x m-3";
    notice.style.zIndex = "2000";
    notice.textContent = `无法加载游戏翻译：${GAME_TRANSLATIONS_URL}`;
    document.body.appendChild(notice);
}

function updateContent() {
    document.title = i18next.t("common:title");

    document.querySelectorAll("[data-i18n]").forEach(function (element) {
        const key = element.getAttribute("data-i18n");
        if (key) {
            element.textContent = i18next.t(key);
        }
    });

    document.querySelectorAll("[data-i18n-placeholder]").forEach(function (element) {
        const key = element.getAttribute("data-i18n-placeholder");
        if (key) {
            element.placeholder = i18next.t(key);
        }
    });

    document.querySelectorAll("option[data-i18n]").forEach(function (element) {
        const key = element.getAttribute("data-i18n");
        if (key) {
            element.textContent = i18next.t(key);
        }
    });

    document.querySelectorAll("option[data-i18n-keys]").forEach(function (element) {
        const keys = JSON.parse(element.dataset.i18nKeys);
        element.textContent = keys.map(function (key) {
            return i18next.t(key, { defaultValue: key.split(".").pop() });
        }).join(" / ");
    });
}

function addLanguageSwitcher() {
    const switcherContainer = document.createElement("div");
    switcherContainer.className = "language-switcher";
    switcherContainer.style.position = "fixed";
    switcherContainer.style.top = "10px";
    switcherContainer.style.right = "10px";
    switcherContainer.style.zIndex = "1000";

    const enButton = document.createElement("button");
    const zhButton = document.createElement("button");

    const refreshButtons = function () {
        enButton.className = "btn btn-sm " + (i18next.language === "en" ? "btn-primary" : "btn-outline-primary");
        zhButton.className = "btn btn-sm " + (i18next.language === "zh" ? "btn-primary" : "btn-outline-primary");
    };

    enButton.textContent = "English";
    enButton.onclick = function () {
        i18next.changeLanguage("en").then(function () {
            updateContent();
            refreshButtons();
        });
    };

    zhButton.textContent = "中文";
    zhButton.onclick = function () {
        i18next.changeLanguage("zh").then(function () {
            updateContent();
            refreshButtons();
        });
    };

    refreshButtons();
    switcherContainer.appendChild(enButton);
    switcherContainer.appendChild(document.createTextNode(" "));
    switcherContainer.appendChild(zhButton);
    document.body.appendChild(switcherContainer);
}
