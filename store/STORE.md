# Fiche Chrome Web Store

Tout ce qu'il faut copier dans le tableau de bord développeur au moment de publier.

## Objectif unique (single purpose)

Afficher une lueur d'ambiance colorée dans les bandes noires du lecteur vidéo de Netflix, calculée à partir de l'image affichée.

## Description courte

- FR : Une lueur d'ambiance dans les bandes noires du lecteur Netflix. Les couleurs suivent l'image, comme sur une TV à éclairage d'ambiance.
- EN : An ambient glow in the black bars of the Netflix player. Colors follow the picture, like a TV with ambient lighting.

## Description longue (FR)

Sur un écran ultrawide, une série en 16:9 laisse deux grandes bandes noires sur les côtés. CinéHalo les remplit avec une lueur qui reprend les couleurs du bord de l'image, zone par zone, et s'éteint doucement vers le bord de l'écran. Ça marche aussi sur les écrans 16:9 avec les films en format cinéma, et même quand les bandes sont encodées dans la vidéo.

Un clic sur l'icône dans l'onglet Netflix (ou Alt+Shift+L) suffit. Trois ambiances, un mode de capture discret à 2 images par seconde ou un mode temps réel, des réglages fins pour l'intensité, la saturation, la portée et la vitesse des transitions, et un mode éco sur batterie.

Tout se passe dans ton navigateur : aucune image n'est enregistrée ni envoyée nulle part.

CinéHalo n'est ni affilié à Netflix ni approuvé par Netflix.

## Long description (EN)

On an ultrawide screen, a 16:9 show leaves two wide black bars on the sides. CinéHalo fills them with a glow that picks up the colors at the edge of the picture, zone by zone, and fades out toward the edge of the screen. It also works on 16:9 screens with widescreen movies, and even when the bars are burned into the video.

One click on the icon in the Netflix tab (or Alt+Shift+L) is all it takes. Three moods, a discreet capture mode at 2 frames per second or a real-time mode, fine controls for intensity, saturation, reach and transition speed, and an eco mode on battery.

Everything happens in your browser: no frame is ever saved or sent anywhere.

CinéHalo is not affiliated with or endorsed by Netflix.

## Justification des permissions

- `activeTab` : la capture d'onglet n'est autorisée qu'après un clic sur l'icône (ou le raccourci) dans l'onglet Netflix. Ça évite de demander l'accès à tous les sites.
- `tabCapture` : mode temps réel, lecture du flux de l'onglet Netflix pour en tirer les couleurs de la lueur. Uniquement à la demande de l'utilisateur.
- `offscreen` : le flux du mode temps réel est analysé dans un document offscreen, le service worker ne pouvant pas lire un flux vidéo.
- `storage` : enregistrer les réglages de l'utilisateur.
- Accès à `https://www.netflix.com/*` (content script) : trouver le lecteur vidéo, mesurer les bandes noires et y dessiner la lueur.

## Usage des données (formulaire de confidentialité)

Aucune donnée utilisateur collectée. Les captures d'onglet sont analysées en mémoire et jetées immédiatement, rien n'est transmis. Politique de confidentialité : `PRIVACY.md` (à héberger sur une page publique, par exemple GitHub Pages, et à lier dans la fiche).

## Visuels

- Icône 128 px : `icons/icon128.png`
- Captures d'écran (1280x800 ou 640x400 attendues par le Store) : à faire sur le vrai Netflix, les images de `docs/` viennent de la page de test.
