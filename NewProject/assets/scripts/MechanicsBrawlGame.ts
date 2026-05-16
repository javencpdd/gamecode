import { _decorator, Color, Component, EventMouse, Graphics, input, Input, Label, Node, profiler, UITransform, Vec2, Vec3 } from 'cc';

const { ccclass } = _decorator;

type GamePhase = 'start' | 'firstDice' | 'planning' | 'turnDice' | 'settling' | 'roundOver' | 'matchOver';
type CardKind =
    | 'windField'
    | 'chargeField'
    | 'frictionZone'
    | 'wallCreate'
    | 'wallBreak'
    | 'massBuff'
    | 'frictionBuff'
    | 'chargeAdjust'
    | 'mathAddMass'
    | 'mathHalfCharge'
    | 'chargeFlip'
    | 'fieldBoost'
    | 'dampingZone';
type TargetMode = 'self' | 'opponent' | 'arena' | 'wall' | 'ownField';
type FieldType = 'wind' | 'charge' | 'friction' | 'damping';
type SoundCue = 'dice' | 'wind' | 'electric' | 'wall' | 'math' | 'click';

interface RectLike {
    x: number;
    y: number;
    w: number;
    h: number;
}

interface CardDef {
    id: string;
    name: string;
    shortName: string;
    family: 'basic' | 'math' | 'newton' | 'maxwell';
    kind: CardKind;
    targetMode: TargetMode;
    durationSec: number;
    color: Color;
    desc: string;
    unitText: string;
    values: Record<string, number>;
}

interface Fighter {
    name: string;
    posM: Vec2;
    velMps: Vec2;
    radiusM: number;
    baseMassKg: number;
    baseChargeC: number;
    baseFriction: number;
    color: Color;
}

interface FighterStats {
    massKg: number;
    chargeC: number;
    friction: number;
}

interface CardIntent {
    id: number;
    owner: number;
    card: CardDef;
    positionM: Vec2;
    direction: Vec2;
    targetWallId?: number;
    summary: string;
}

interface FieldSource {
    id: number;
    owner: number;
    type: FieldType;
    positionM: Vec2;
    direction: Vec2;
    radiusM: number;
    maxForceN: number;
    sourceChargeC: number;
    frictionDelta: number;
    remainingSec: number;
    label: string;
    color: Color;
}

interface WallBody {
    id: number;
    owner: number;
    centerM: Vec2;
    sizeM: Vec2;
    hp: number;
    maxHp: number;
    remainingSec: number;
    permanent: boolean;
    breakable: boolean;
    wallFriction: number;
    color: Color;
}

interface AttributeEffect {
    id: number;
    owner: number;
    target: number;
    massDeltaKg: number;
    frictionDelta: number;
    chargeDeltaC: number;
    remainingSec: number;
    label: string;
}

@ccclass('MechanicsBrawlGame')
export class MechanicsBrawlGame extends Component {
    private canvas!: UITransform;
    private worldG!: Graphics;
    private hudG!: Graphics;
    private labels: Record<string, Label> = {};
    private cardLabels: Label[] = [];

    private fighters: Fighter[] = [];
    private commonCards: CardDef[] = [];
    private decks: CardDef[][] = [[], []];
    private hands: CardDef[][] = [[], []];
    private pendingIntents: CardIntent[] = [];
    private fields: FieldSource[] = [];
    private walls: WallBody[] = [];
    private attrEffects: AttributeEffect[] = [];

    private phase: GamePhase = 'start';
    private currentPlayer = 0;
    private selectedCard = -1;
    private draggingCard = false;
    private pressedCardIndex = -1;
    private pointerDownPoint = new Vec2();
    private aimPoint = new Vec2();

    private roundWins = [0, 0];
    private roundNumber = 1;
    private nextRoundFirst = 0;
    private actionTurnCount = 0;
    private playerActionCounts = [0, 0];
    private cardsPlannedThisTurn = 0;
    private discardsThisTurn = 0;

    private turnTimer = 120;
    private dice = 1;
    private diceTarget = 1;
    private diceTimer = 0;
    private diceDuration = 1.1;
    private settleRemaining = 0;
    private settleElapsed = 0;
    private lastForces: Vec2[] = [new Vec2(), new Vec2()];

    private cardInfoText = '';
    private message = '点击开始，进入像素实验台。';
    private intentId = 1;
    private fieldId = 1;
    private wallId = 1;
    private attrEffectId = 1;
    private snowTick = 0;
    private audioCtx: any = null;

    private readonly arenaM: RectLike = { x: -6, y: -3.4, w: 12, h: 6.8 };
    private readonly pxPerM = 74;
    private readonly maxHandSize = 6;
    private readonly openingHandSize = 4;
    private readonly cardsDrawnPerTurn = 2;
    private readonly maxDiscardsPerTurn = 2;
    private readonly maxActionTurns = 30;
    private readonly cardW = 112;
    private readonly cardH = 70;
    private readonly cardGap = 10;
    private readonly dragStartThreshold = 12;

    onLoad() {
        this.node.removeAllChildren();
        this.canvas = this.node.getComponent(UITransform) || this.node.addComponent(UITransform);
        this.canvas.setContentSize(1280, 720);
        this.createCards();
        this.createLayers();
        this.createLabels();
        this.resetToStart();
        profiler.hideStats();

        input.on(Input.EventType.MOUSE_DOWN, this.onMouseDown, this);
        input.on(Input.EventType.MOUSE_MOVE, this.onMouseMove, this);
        input.on(Input.EventType.MOUSE_UP, this.onMouseUp, this);
    }

    onDestroy() {
        input.off(Input.EventType.MOUSE_DOWN, this.onMouseDown, this);
        input.off(Input.EventType.MOUSE_MOVE, this.onMouseMove, this);
        input.off(Input.EventType.MOUSE_UP, this.onMouseUp, this);
    }

    update(deltaTime: number) {
        const dt = Math.min(deltaTime, 1 / 20);

        if (this.phase === 'planning') {
            this.turnTimer = Math.max(0, this.turnTimer - dt);
            if (this.turnTimer <= 0) {
                this.endPlanning('120 秒倒计时结束，自动结束行动。');
            }
        } else if (this.phase === 'firstDice' || this.phase === 'turnDice') {
            this.updateDice(dt);
        } else if (this.phase === 'settling') {
            this.updateSettlement(dt);
        }

        this.snowTick += dt;
        this.draw();
    }

    private createLayers() {
        const world = new Node('WorldCanvas');
        world.layer = this.node.layer;
        world.setParent(this.node);
        world.addComponent(UITransform).setContentSize(1280, 720);
        this.worldG = world.addComponent(Graphics);

        const hud = new Node('HudCanvas');
        hud.layer = this.node.layer;
        hud.setParent(this.node);
        hud.addComponent(UITransform).setContentSize(1280, 720);
        this.hudG = hud.addComponent(Graphics);
    }

    private createLabels() {
        this.makeLabel('title', 0, 328, 560, 34, 24, new Color(244, 247, 255, 255));
        this.makeLabel('turn', -250, 292, 360, 30, 16, new Color(228, 239, 255, 255));
        this.makeLabel('timer', 126, 292, 300, 30, 16, new Color(255, 226, 136, 255));
        this.makeLabel('field', 0, 251, 900, 38, 13, new Color(189, 255, 218, 255));
        this.makeLabel('message', 0, 270, 820, 30, 16, new Color(206, 226, 255, 255));
        this.makeLabel('p0', -508, 205, 255, 96, 12, new Color(206, 233, 255, 255));
        this.makeLabel('p1', 508, 205, 255, 96, 12, new Color(255, 218, 218, 255));
        this.makeLabel('hint', 0, -214, 960, 24, 13, new Color(178, 190, 205, 255));
        this.makeLabel('cardInfo', 0, -245, 1120, 54, 12, new Color(228, 236, 248, 255));
        this.makeLabel('reset', 571, 311, 88, 28, 15, new Color(238, 244, 255, 255));
        this.makeLabel('action', 571, 265, 88, 28, 15, new Color(238, 244, 255, 255));
        this.makeLabel('discard', 457, 265, 88, 28, 15, new Color(238, 244, 255, 255));

        for (let i = 0; i < this.maxHandSize; i++) {
            const r = this.cardRect(i);
            const label = this.makeLabel(`card_${i}`, r.x + r.w / 2, r.y + r.h / 2 - 2, r.w - 6, r.h - 8, 13, new Color(238, 242, 249, 255));
            this.cardLabels.push(label);
        }
    }

    private makeLabel(key: string, x: number, y: number, w: number, h: number, size: number, color: Color) {
        const node = new Node(key);
        node.layer = this.node.layer;
        node.setParent(this.node);
        node.setPosition(x, y, 0);
        node.addComponent(UITransform).setContentSize(w, h);

        const label = node.addComponent(Label);
        label.fontSize = size;
        label.lineHeight = Math.round(size * 1.18);
        label.color = color;
        label.horizontalAlign = 1 as any;
        label.verticalAlign = 1 as any;
        (label as any).overflow = 2;
        (label as any).enableWrapText = true;
        this.labels[key] = label;
        return label;
    }

    private createCards() {
        const c = (id: string, name: string, shortName: string, family: CardDef['family'], kind: CardKind, targetMode: TargetMode, durationSec: number, color: Color, desc: string, unitText: string, values: Record<string, number>): CardDef => ({
            id,
            name,
            shortName,
            family,
            kind,
            targetMode,
            durationSec,
            color,
            desc,
            unitText,
            values,
        });

        const basic = [
            c('basic_wind', '轻风标记', '轻风\n标记', 'basic', 'windField', 'arena', 2, new Color(118, 216, 255, 255), '放置弱方向风场。回合末结算时，范围内角色受到固定方向小作用力。', '半径 2.4 m，作用力 0.45 N，持续 2 s', { radiusM: 2.4, forceN: 0.45 }),
            c('basic_charge', '静电标记', '静电\n标记', 'basic', 'chargeField', 'arena', 3, new Color(255, 214, 95, 255), '放置固定电荷点。源电荷正负由当前玩家决定，数值偏小。', '半径 3.0 m，最大作用力 0.65 N，源电荷 1.2 C，持续 3 s', { radiusM: 3.0, forceN: 0.65, chargeC: 1.2 }),
            c('rough_zone', '粗糙地带', '粗糙\n地带', 'basic', 'frictionZone', 'arena', 3, new Color(166, 213, 122, 255), '放置摩擦区。角色经过时速度衰减更明显。', '半径 2.1 m，摩擦系数 +0.10，持续 3 s', { radiusM: 2.1, frictionDelta: 0.10 }),
            c('smooth_zone', '光滑地带', '光滑\n地带', 'basic', 'frictionZone', 'arena', 2, new Color(94, 229, 214, 255), '放置低摩擦冰面。视觉偏蓝并带雪花反馈。', '半径 2.2 m，摩擦系数 -0.06，持续 2 s', { radiusM: 2.2, frictionDelta: -0.06 }),
            c('temp_wall', '临时隔板', '临时\n隔板', 'basic', 'wallCreate', 'arena', 3, new Color(190, 144, 255, 255), '放置固定形状刚性墙体。墙体不反弹，只吸收法向速度。', '尺寸 1.6 m x 0.18 m，耐久 2，持续 3 s', { wallW: 1.6, wallH: 0.18, hp: 2 }),
            c('crack_hammer', '裂解锤', '裂解\n锤', 'basic', 'wallBreak', 'wall', 0, new Color(255, 156, 101, 255), '选择一段可破坏墙体。回合末扣除耐久。', '墙体耐久 -2，结算前一次性', { damage: 2 }),
            c('shoe_spikes', '稳定鞋钉', '稳定\n鞋钉', 'basic', 'frictionBuff', 'self', 2, new Color(171, 238, 147, 255), '临时提高自身摩擦系数，使角色更容易停住。', '自身摩擦系数 +0.08，持续 2 s', { frictionDelta: 0.08 }),
            c('mass_light', '轻量校准', '轻量\n校准', 'basic', 'massBuff', 'self', 2, new Color(139, 207, 255, 255), '临时降低自身质量，更容易被场源影响。', '自身质量 -0.25 kg，持续 2 s', { massDeltaKg: -0.25 }),
            c('mass_heavy', '重量校准', '重量\n校准', 'basic', 'massBuff', 'self', 2, new Color(255, 201, 111, 255), '临时提高自身质量，更难被弱场源推动。', '自身质量 +0.35 kg，持续 2 s', { massDeltaKg: 0.35 }),
            c('discharge', '放电校准', '放电\n校准', 'basic', 'chargeAdjust', 'opponent', 0, new Color(255, 174, 220, 255), '让对手电荷向 0 靠近，削弱电磁受力。', '对手电荷向 0 靠近 1 C，结算前一次性', { towardZeroC: 1 }),
        ];

        const math = [
            c('math_mass_plus', '加一校准', '加一\n校准', 'math', 'mathAddMass', 'self', 1, new Color(255, 238, 139, 255), '基础数学牌。把自身质量增加 1 个 kg 单位，执行边界限制。', '自身质量 +1 kg，持续 1 s，质量范围 0.5-5.0 kg', { massDeltaKg: 1 }),
            c('math_charge_half', '半值衰减', '半值\n衰减', 'math', 'mathHalfCharge', 'opponent', 0, new Color(221, 172, 255, 255), '基础数学牌。把对手电荷除以 2，执行边界限制。', '对手电荷 /2，结算前一次性，电荷范围 -5 C 到 5 C', { chargeMultiplier: 0.5 }),
            c('math_field_boost', '倍率放大', '倍率\n放大', 'math', 'fieldBoost', 'ownField', 2, new Color(255, 203, 119, 255), '基础数学牌。强化一个己方场源，但仍有上限。', '最近己方场源强度 x1.5，上限 2.0 N', { multiplier: 1.5 }),
        ];

        const newton = [
            c('newton_inertia', '惯性锁定', '惯性\n锁定', 'newton', 'massBuff', 'self', 2, new Color(93, 164, 255, 255), '牛顿专属。提高自身质量和抗扰动能力。', '自身质量 +0.8 kg，持续 2 s', { massDeltaKg: 0.8 }),
            c('newton_board', '牛顿挡板', '牛顿\n挡板', 'newton', 'wallCreate', 'arena', 4, new Color(111, 145, 210, 255), '牛顿专属。生成更厚的短墙，控制路线。', '尺寸 1.8 m x 0.20 m，耐久 3，持续 4 s', { wallW: 1.8, wallH: 0.2, hp: 3 }),
            c('newton_break', '支点破坏', '支点\n破坏', 'newton', 'wallBreak', 'wall', 0, new Color(255, 150, 82, 255), '牛顿专属。重击可破坏墙体。', '墙体耐久 -3，结算前一次性', { damage: 3 }),
            c('newton_damping', '静止参考系', '静止\n参考', 'newton', 'dampingZone', 'arena', 2, new Color(157, 213, 255, 255), '牛顿专属。放置阻尼区，使范围内速度衰减更强。', '半径 2.2 m，阻尼 +0.16，持续 2 s', { radiusM: 2.2, frictionDelta: 0.16 }),
        ];

        const maxwell = [
            c('maxwell_charge', '微型电荷点', '微型\n电荷', 'maxwell', 'chargeField', 'arena', 3, new Color(255, 118, 126, 255), '麦克斯韦专属。放置更强但仍偏小的电荷点。', '半径 3.2 m，最大作用力 0.80 N，源电荷 1.5 C，持续 3 s', { radiusM: 3.2, forceN: 0.8, chargeC: 1.5 }),
            c('maxwell_wind', '风矢量', '风\n矢量', 'maxwell', 'windField', 'arena', 2, new Color(103, 232, 218, 255), '麦克斯韦专属。通过鼠标方向设置风场。', '半径 2.6 m，作用力 0.65 N，持续 2 s', { radiusM: 2.6, forceN: 0.65 }),
            c('maxwell_flip', '电荷翻转', '电荷\n翻转', 'maxwell', 'chargeFlip', 'opponent', 0, new Color(255, 143, 225, 255), '麦克斯韦专属。把对手电荷取反，改变电磁方向。', '对手电荷取反，结算前一次性，范围 -5 C 到 5 C', { chargeMultiplier: -1 }),
            c('maxwell_smooth', '等势线', '等势\n线', 'maxwell', 'frictionZone', 'arena', 2, new Color(158, 184, 255, 255), '麦克斯韦专属。放置轻微低摩擦区，辅助场源组合。', '半径 2.3 m，摩擦系数 -0.03，持续 2 s', { radiusM: 2.3, frictionDelta: -0.03 }),
        ];

        this.commonCards = [...basic, ...math];
        this.decks = [
            [...basic, ...math, ...newton],
            [...basic, ...math, ...maxwell],
        ];
    }

    private resetToStart() {
        this.phase = 'start';
        this.roundWins = [0, 0];
        this.roundNumber = 1;
        this.nextRoundFirst = 0;
        this.currentPlayer = 0;
        this.hands = [[], []];
        this.pendingIntents = [];
        this.fields = [];
        this.walls = [];
        this.attrEffects = [];
        this.selectedCard = -1;
        this.cardInfoText = '';
        this.turnTimer = 120;
        this.message = '点击开始，进入像素实验台。开局骰子点数 1-3 牛顿先手，4-6 麦克斯韦先手。';
        this.createInitialFighters();
    }

    private beginMatch() {
        this.roundWins = [0, 0];
        this.roundNumber = 1;
        this.createInitialFighters();
        this.startFirstDice();
    }

    private startFirstDice() {
        this.phase = 'firstDice';
        this.diceTimer = 0;
        this.diceDuration = 1.2;
        this.diceTarget = this.rollDice();
        this.message = '开局掷骰决定先手。';
        this.playCue('dice');
    }

    private setupRound(firstPlayer: number) {
        this.currentPlayer = firstPlayer;
        this.actionTurnCount = 0;
        this.playerActionCounts = [0, 0];
        this.pendingIntents = [];
        this.fields = [];
        this.attrEffects = [];
        this.selectedCard = -1;
        this.cardInfoText = '';
        this.createInitialFighters();
        this.createInitialWalls();
        this.dealOpeningHands();
        this.startPlanning(`第 ${this.roundNumber} 局开始，${this.fighters[this.currentPlayer].name} 行动。`);
    }

    private createInitialFighters() {
        this.fighters = [
            {
                name: '牛顿',
                posM: new Vec2(-4.6, 0),
                velMps: new Vec2(),
                radiusM: 0.32,
                baseMassKg: 2.4,
                baseChargeC: 1,
                baseFriction: 0.20,
                color: new Color(66, 163, 255, 255),
            },
            {
                name: '麦克斯韦',
                posM: new Vec2(4.6, 0),
                velMps: new Vec2(),
                radiusM: 0.30,
                baseMassKg: 1.8,
                baseChargeC: -1,
                baseFriction: 0.14,
                color: new Color(255, 92, 105, 255),
            },
        ];
        this.lastForces = [new Vec2(), new Vec2()];
    }

    private createInitialWalls() {
        this.walls = [];
        this.addWall(-3.2, 0, 0.22, 1.8, -1, 99, 0, true, false);
        this.addWall(3.2, 0, 0.22, 1.8, -1, 99, 0, true, false);
        this.addWall(0, 1.9, 1.8, 0.22, -1, 99, 0, true, false);
        this.addWall(0, -1.9, 1.8, 0.22, -1, 99, 0, true, false);
    }

    private dealOpeningHands() {
        this.hands = [[], []];
        for (let player = 0; player < 2; player++) {
            for (let i = 0; i < this.openingHandSize; i++) {
                this.hands[player].push(this.drawCardForPlayer(player));
            }
        }
    }

    private startPlanning(prefix = '') {
        this.phase = 'planning';
        this.turnTimer = 120;
        this.cardsPlannedThisTurn = 0;
        this.discardsThisTurn = 0;
        this.pendingIntents = [];
        this.selectedCard = -1;
        this.draggingCard = false;
        this.pressedCardIndex = -1;
        const drawn = this.drawTurnCards(this.currentPlayer);
        const intro = prefix ? `${prefix} ` : '';
        this.message = `${intro}${this.fighters[this.currentPlayer].name} 抽 ${drawn} 张。出牌只进入计划队列，点击结束后才掷骰并统一结算 1 秒。`;
    }

    private currentHand() {
        return this.hands[this.currentPlayer] || [];
    }

    private drawCardForPlayer(playerIndex: number) {
        const deck = this.decks[playerIndex];
        return deck[Math.floor(Math.random() * deck.length)];
    }

    private drawTurnCards(playerIndex: number) {
        const hand = this.hands[playerIndex];
        let drawn = 0;
        while (drawn < this.cardsDrawnPerTurn && hand.length < this.maxHandSize) {
            hand.push(this.drawCardForPlayer(playerIndex));
            drawn += 1;
        }
        return drawn;
    }

    private discardSelectedCard() {
        if (this.phase !== 'planning') {
            return;
        }
        if (this.selectedCard < 0 || !this.currentHand()[this.selectedCard]) {
            this.message = '先单击一张手牌，再点击弃牌。';
            return;
        }
        if (this.discardsThisTurn >= this.maxDiscardsPerTurn) {
            this.message = `本行动回合最多弃 ${this.maxDiscardsPerTurn} 张牌。`;
            return;
        }
        const card = this.currentHand()[this.selectedCard];
        this.currentHand().splice(this.selectedCard, 1);
        this.discardsThisTurn += 1;
        this.selectedCard = -1;
        this.cardInfoText = '';
        this.message = `${this.fighters[this.currentPlayer].name} 弃掉 ${card.name}。弃牌不立即补牌，下次行动开始抽牌。`;
        this.playCue('click');
    }

    private queueSelectedCard(point: Vec2) {
        if (this.selectedCard < 0) {
            return;
        }
        const hand = this.currentHand();
        const card = hand[this.selectedCard];
        if (!card) {
            return;
        }
        if (!this.inArenaPx(point)) {
            this.message = '把卡牌拖到实验台内释放，才会加入本回合计划。';
            return;
        }

        const owner = this.currentPlayer;
        const positionM = this.pxToWorld(point);
        const actor = this.fighters[owner];
        let direction = this.directionBetween(actor.posM, positionM);
        if (Math.hypot(direction.x, direction.y) < 0.001) {
            direction = new Vec2(owner === 0 ? 1 : -1, 0);
        }

        const targetWall = card.kind === 'wallBreak' ? this.findNearestBreakableWall(positionM, 1.2) : undefined;
        if (card.kind === 'wallBreak' && !targetWall) {
            this.message = '没有选中可破坏墙体。把破墙卡拖到目标墙体附近。';
            return;
        }
        if (card.kind === 'fieldBoost' && !this.findLatestOwnField(owner)) {
            this.message = '当前没有己方场源可强化。';
            return;
        }
        if (card.family === 'math' && this.pendingIntents.some((intent) => intent.card.family === 'math')) {
            this.message = '基础数学牌每个行动回合最多计划 1 张，避免数值连锁过强。';
            return;
        }

        const intent: CardIntent = {
            id: this.intentId++,
            owner,
            card,
            positionM,
            direction,
            targetWallId: targetWall?.id,
            summary: this.intentSummary(card, positionM, direction, targetWall),
        };

        this.pendingIntents.push(intent);
        hand.splice(this.selectedCard, 1);
        this.cardsPlannedThisTurn += 1;
        this.cardInfoText = this.intentDetails(intent);
        this.selectedCard = -1;
        this.draggingCard = false;
        this.pressedCardIndex = -1;
        this.message = `${this.fighters[owner].name} 计划 ${card.name}。尚未生效；结束行动并完成骰子过场后才进入 1 秒结算。`;
        this.playCue('click');
    }

    private endPlanning(reason = '') {
        if (this.phase !== 'planning') {
            return;
        }
        this.actionTurnCount += 1;
        this.playerActionCounts[this.currentPlayer] += 1;
        this.selectedCard = -1;
        this.draggingCard = false;
        this.pressedCardIndex = -1;
        this.phase = 'turnDice';
        this.diceTimer = 0;
        this.diceDuration = 1.0;
        this.diceTarget = this.rollDice();
        const prefix = reason ? `${reason} ` : '';
        this.message = `${prefix}${this.fighters[this.currentPlayer].name} 行动结束，播放回合末骰子。动画结束后再开始移动。`;
        this.playCue('dice');
    }

    private updateDice(dt: number) {
        this.diceTimer += dt;
        if (Math.floor(this.diceTimer * 18) % 2 === 0) {
            this.dice = this.rollDice();
        }

        if (this.diceTimer < this.diceDuration) {
            return;
        }

        this.dice = this.diceTarget;
        if (this.phase === 'firstDice') {
            const first = this.dice <= 3 ? 0 : 1;
            this.setupRound(first);
            return;
        }

        if (this.phase === 'turnDice') {
            this.activatePendingIntents();
            this.phase = 'settling';
            this.settleRemaining = 1;
            this.settleElapsed = 0;
            this.message = `骰子点数 ${this.dice}。所有新旧有效效果一起作用，开始 1 秒统一物理结算。`;
            this.playSettlementCue();
        }
    }

    private activatePendingIntents() {
        for (const intent of this.pendingIntents) {
            const card = intent.card;
            const owner = intent.owner;
            const opponent = 1 - owner;

            switch (card.kind) {
                case 'windField':
                    this.addField(owner, 'wind', intent.positionM, intent.direction, card.values.radiusM, card.values.forceN, 0, 0, card.durationSec, card.name, card.color);
                    break;
                case 'chargeField': {
                    const sign = owner === 0 ? 1 : -1;
                    this.addField(owner, 'charge', intent.positionM, new Vec2(), card.values.radiusM, card.values.forceN, card.values.chargeC * sign, 0, card.durationSec, card.name, card.color);
                    break;
                }
                case 'frictionZone':
                case 'dampingZone':
                    this.addField(owner, card.kind === 'dampingZone' ? 'damping' : 'friction', intent.positionM, new Vec2(), card.values.radiusM, 0, 0, card.values.frictionDelta, card.durationSec, card.name, card.color);
                    break;
                case 'wallCreate':
                    this.tryCreateWallFromIntent(intent);
                    break;
                case 'wallBreak':
                    this.damageWall(intent.targetWallId, card.values.damage);
                    break;
                case 'massBuff':
                    this.addAttrEffect(owner, owner, card.values.massDeltaKg || 0, 0, 0, card.durationSec, card.name);
                    break;
                case 'frictionBuff':
                    this.addAttrEffect(owner, owner, 0, card.values.frictionDelta || 0, 0, card.durationSec, card.name);
                    break;
                case 'chargeAdjust':
                    this.adjustChargeTowardZero(opponent, card.values.towardZeroC || 1);
                    break;
                case 'mathAddMass':
                    this.addAttrEffect(owner, owner, card.values.massDeltaKg || 1, 0, 0, card.durationSec, card.name);
                    this.playCue('math');
                    break;
                case 'mathHalfCharge':
                    this.fighters[opponent].baseChargeC = this.clamp(this.fighters[opponent].baseChargeC * (card.values.chargeMultiplier || 0.5), -5, 5);
                    this.playCue('math');
                    break;
                case 'chargeFlip':
                    this.fighters[opponent].baseChargeC = this.clamp(-this.fighters[opponent].baseChargeC, -5, 5);
                    this.playCue('electric');
                    break;
                case 'fieldBoost':
                    this.boostLatestOwnField(owner, card.values.multiplier || 1.5);
                    this.playCue('math');
                    break;
            }
        }
        this.pendingIntents = [];
    }

    private updateSettlement(dt: number) {
        if (this.phase !== 'settling') {
            return;
        }
        const step = Math.min(dt, this.settleRemaining);
        this.stepPhysics(step);
        this.settleRemaining -= step;
        this.settleElapsed += step;

        if (this.phase !== 'settling') {
            return;
        }
        if (this.settleRemaining <= 0.0001) {
            this.finishSettlement();
        }
    }

    private stepPhysics(dt: number) {
        const forces = [this.computeForceOnFighter(0), this.computeForceOnFighter(1)];
        this.lastForces = [this.cloneVec(forces[0]), this.cloneVec(forces[1])];

        for (let i = 0; i < this.fighters.length; i++) {
            const f = this.fighters[i];
            const stats = this.effectiveStats(i);
            f.velMps.x += (forces[i].x / stats.massKg) * dt;
            f.velMps.y += (forces[i].y / stats.massKg) * dt;

            const localFriction = this.localFrictionAt(f.posM);
            const friction = this.clamp(stats.friction + localFriction, 0.02, 0.90);
            const damping = Math.max(0, 1 - friction * 2.4 * dt);
            f.velMps.x *= damping;
            f.velMps.y *= damping;

            f.posM.x += f.velMps.x * dt;
            f.posM.y += f.velMps.y * dt;
        }

        this.resolveFighterCollision();
        this.resolveWallCollisions();
        this.checkRingOut();
    }

    private finishSettlement() {
        this.tickDurations();

        if (this.actionTurnCount >= this.maxActionTurns) {
            const d0 = Math.hypot(this.fighters[0].posM.x, this.fighters[0].posM.y);
            const d1 = Math.hypot(this.fighters[1].posM.x, this.fighters[1].posM.y);
            const winner = d0 <= d1 ? 0 : 1;
            this.finishRound(winner, `达到 ${this.maxActionTurns} 个行动回合，按中心距离判定：${this.fighters[winner].name} 更接近中心。`);
            return;
        }

        this.currentPlayer = 1 - this.currentPlayer;
        this.startPlanning(`1 秒结算结束，轮到 ${this.fighters[this.currentPlayer].name}。`);
    }

    private tickDurations() {
        for (const field of this.fields) {
            field.remainingSec -= 1;
        }
        this.fields = this.fields.filter((field) => field.remainingSec > 0);

        for (const wall of this.walls) {
            if (!wall.permanent) {
                wall.remainingSec -= 1;
            }
        }
        this.walls = this.walls.filter((wall) => wall.permanent || wall.remainingSec > 0);

        for (const effect of this.attrEffects) {
            effect.remainingSec -= 1;
        }
        this.attrEffects = this.attrEffects.filter((effect) => effect.remainingSec > 0);
    }

    private computeForceOnFighter(index: number) {
        const fighter = this.fighters[index];
        const stats = this.effectiveStats(index);
        const force = new Vec2();

        for (const field of this.fields) {
            const dx = fighter.posM.x - field.positionM.x;
            const dy = fighter.posM.y - field.positionM.y;
            const dist = Math.max(0.001, Math.hypot(dx, dy));
            if (dist > field.radiusM) {
                continue;
            }
            const falloff = this.clamp(1 - dist / field.radiusM, 0, 1);
            if (field.type === 'wind') {
                force.x += field.direction.x * field.maxForceN * falloff;
                force.y += field.direction.y * field.maxForceN * falloff;
            } else if (field.type === 'charge') {
                const sameSign = field.sourceChargeC * stats.chargeC >= 0;
                const nx = sameSign ? dx / dist : -dx / dist;
                const ny = sameSign ? dy / dist : -dy / dist;
                const chargeScale = this.clamp(Math.abs(stats.chargeC) / 2, 0.25, 1.4);
                const mag = field.maxForceN * falloff * chargeScale;
                force.x += nx * mag;
                force.y += ny * mag;
            }
        }

        const other = this.fighters[1 - index];
        const otherStats = this.effectiveStats(1 - index);
        const dx = fighter.posM.x - other.posM.x;
        const dy = fighter.posM.y - other.posM.y;
        const dist = Math.max(0.001, Math.hypot(dx, dy));
        if (dist < 5.2) {
            const sameSign = stats.chargeC * otherStats.chargeC >= 0;
            const nx = sameSign ? dx / dist : -dx / dist;
            const ny = sameSign ? dy / dist : -dy / dist;
            const chargeScale = this.clamp(Math.abs(stats.chargeC * otherStats.chargeC) / 4, 0, 1);
            const mag = 0.55 * this.clamp(1 - dist / 5.2, 0, 1) * chargeScale;
            force.x += nx * mag;
            force.y += ny * mag;
        }

        return force;
    }

    private effectiveStats(index: number): FighterStats {
        const f = this.fighters[index];
        let massKg = f.baseMassKg;
        let chargeC = f.baseChargeC;
        let friction = f.baseFriction;

        for (const effect of this.attrEffects) {
            if (effect.target !== index) {
                continue;
            }
            massKg += effect.massDeltaKg;
            chargeC += effect.chargeDeltaC;
            friction += effect.frictionDelta;
        }

        return {
            massKg: this.clamp(massKg, 0.5, 5.0),
            chargeC: this.clamp(chargeC, -5, 5),
            friction: this.clamp(friction, 0.02, 0.80),
        };
    }

    private localFrictionAt(positionM: Vec2) {
        let delta = 0;
        for (const field of this.fields) {
            if (field.type !== 'friction' && field.type !== 'damping') {
                continue;
            }
            const dist = Math.hypot(positionM.x - field.positionM.x, positionM.y - field.positionM.y);
            if (dist <= field.radiusM) {
                const falloff = this.clamp(1 - dist / field.radiusM, 0.15, 1);
                delta += field.frictionDelta * falloff;
            }
        }
        return delta;
    }

    private resolveFighterCollision() {
        const a = this.fighters[0];
        const b = this.fighters[1];
        const dx = b.posM.x - a.posM.x;
        const dy = b.posM.y - a.posM.y;
        const dist = Math.max(0.001, Math.hypot(dx, dy));
        const minDist = a.radiusM + b.radiusM;
        if (dist >= minDist) {
            return;
        }

        const nx = dx / dist;
        const ny = dy / dist;
        const overlap = minDist - dist;
        a.posM.x -= nx * overlap * 0.5;
        a.posM.y -= ny * overlap * 0.5;
        b.posM.x += nx * overlap * 0.5;
        b.posM.y += ny * overlap * 0.5;

        const relX = b.velMps.x - a.velMps.x;
        const relY = b.velMps.y - a.velMps.y;
        const alongNormal = relX * nx + relY * ny;
        if (alongNormal >= 0) {
            return;
        }
        a.velMps.x += alongNormal * 0.5 * nx;
        a.velMps.y += alongNormal * 0.5 * ny;
        b.velMps.x -= alongNormal * 0.5 * nx;
        b.velMps.y -= alongNormal * 0.5 * ny;
    }

    private resolveWallCollisions() {
        for (const fighter of this.fighters) {
            for (const wall of this.walls) {
                const halfW = wall.sizeM.x / 2;
                const halfH = wall.sizeM.y / 2;
                const closestX = this.clamp(fighter.posM.x, wall.centerM.x - halfW, wall.centerM.x + halfW);
                const closestY = this.clamp(fighter.posM.y, wall.centerM.y - halfH, wall.centerM.y + halfH);
                const dx = fighter.posM.x - closestX;
                const dy = fighter.posM.y - closestY;
                const dist = Math.hypot(dx, dy);
                if (dist >= fighter.radiusM && dist > 0.0001) {
                    continue;
                }

                let nx = 0;
                let ny = 0;
                if (dist > 0.0001) {
                    nx = dx / dist;
                    ny = dy / dist;
                } else {
                    const left = Math.abs(fighter.posM.x - (wall.centerM.x - halfW));
                    const right = Math.abs((wall.centerM.x + halfW) - fighter.posM.x);
                    const bottom = Math.abs(fighter.posM.y - (wall.centerM.y - halfH));
                    const top = Math.abs((wall.centerM.y + halfH) - fighter.posM.y);
                    const min = Math.min(left, right, bottom, top);
                    if (min === left) {
                        nx = -1;
                    } else if (min === right) {
                        nx = 1;
                    } else if (min === bottom) {
                        ny = -1;
                    } else {
                        ny = 1;
                    }
                }

                const push = fighter.radiusM - dist + 0.002;
                fighter.posM.x += nx * push;
                fighter.posM.y += ny * push;

                const normalSpeed = fighter.velMps.x * nx + fighter.velMps.y * ny;
                if (normalSpeed < 0) {
                    fighter.velMps.x -= normalSpeed * nx;
                    fighter.velMps.y -= normalSpeed * ny;
                }
                const tangentX = -ny;
                const tangentY = nx;
                const tangentSpeed = fighter.velMps.x * tangentX + fighter.velMps.y * tangentY;
                fighter.velMps.x = tangentX * tangentSpeed * (1 - wall.wallFriction);
                fighter.velMps.y = tangentY * tangentSpeed * (1 - wall.wallFriction);
            }
        }
    }

    private checkRingOut() {
        if (this.phase !== 'settling') {
            return;
        }
        for (let i = 0; i < this.fighters.length; i++) {
            const f = this.fighters[i];
            const out =
                f.posM.x < this.arenaM.x ||
                f.posM.x > this.arenaM.x + this.arenaM.w ||
                f.posM.y < this.arenaM.y ||
                f.posM.y > this.arenaM.y + this.arenaM.h;
            if (out) {
                this.finishRound(1 - i, `${this.fighters[i].name} 出界。`);
                return;
            }
        }
    }

    private finishRound(winner: number, reason: string) {
        this.roundWins[winner] += 1;
        this.selectedCard = -1;
        this.draggingCard = false;
        this.pendingIntents = [];
        this.fields = [];
        this.attrEffects = [];
        this.playCue('wall');

        if (this.roundWins[winner] >= 2) {
            this.phase = 'matchOver';
            this.message = `${reason}${this.fighters[winner].name} 拿下第 ${this.roundNumber} 局，并以 ${this.roundWins[0]}:${this.roundWins[1]} 赢得整场比赛。`;
            return;
        }

        this.phase = 'roundOver';
        this.nextRoundFirst = 1 - winner;
        this.message = `${reason}${this.fighters[winner].name} 赢得第 ${this.roundNumber} 局。下一局败者先手：${this.fighters[this.nextRoundFirst].name}。`;
        this.roundNumber += 1;
    }

    private addField(owner: number, type: FieldType, positionM: Vec2, direction: Vec2, radiusM: number, maxForceN: number, sourceChargeC: number, frictionDelta: number, durationSec: number, label: string, color: Color) {
        const ownFields = this.fields.filter((field) => field.owner === owner);
        if (ownFields.length >= 3) {
            ownFields.sort((a, b) => a.remainingSec - b.remainingSec);
            this.fields = this.fields.filter((field) => field.id !== ownFields[0].id);
        }
        const dir = this.normalized(direction, owner === 0 ? new Vec2(1, 0) : new Vec2(-1, 0));
        this.fields.push({
            id: this.fieldId++,
            owner,
            type,
            positionM: this.cloneVec(positionM),
            direction: dir,
            radiusM,
            maxForceN: this.clamp(maxForceN, 0, 2.0),
            sourceChargeC: this.clamp(sourceChargeC, -5, 5),
            frictionDelta,
            remainingSec: durationSec,
            label,
            color,
        });
    }

    private addWall(cx: number, cy: number, w: number, h: number, owner: number, hp: number, durationSec: number, permanent: boolean, breakable: boolean) {
        this.walls.push({
            id: this.wallId++,
            owner,
            centerM: new Vec2(cx, cy),
            sizeM: new Vec2(w, h),
            hp,
            maxHp: hp,
            remainingSec: durationSec,
            permanent,
            breakable,
            wallFriction: 0.25,
            color: permanent ? new Color(82, 103, 132, 255) : owner === 0 ? new Color(84, 136, 211, 255) : new Color(180, 78, 102, 255),
        });
    }

    private tryCreateWallFromIntent(intent: CardIntent) {
        const card = intent.card;
        const horizontal = Math.abs(intent.direction.x) >= Math.abs(intent.direction.y);
        const w = horizontal ? card.values.wallW : card.values.wallH;
        const h = horizontal ? card.values.wallH : card.values.wallW;
        const center = intent.positionM;

        if (!this.isWallPlacementLegal(center, w, h)) {
            this.message = `${card.name} 的墙体位置非法，已失效：不能重叠角色、堵住中心或超出地图。`;
            return;
        }

        const ownTempWalls = this.walls.filter((wall) => wall.owner === intent.owner && !wall.permanent);
        if (ownTempWalls.length >= 2) {
            ownTempWalls.sort((a, b) => a.remainingSec - b.remainingSec);
            this.walls = this.walls.filter((wall) => wall.id !== ownTempWalls[0].id);
        }

        this.addWall(center.x, center.y, w, h, intent.owner, card.values.hp, card.durationSec, false, true);
        this.playCue('wall');
    }

    private isWallPlacementLegal(center: Vec2, w: number, h: number) {
        if (center.x - w / 2 < this.arenaM.x || center.x + w / 2 > this.arenaM.x + this.arenaM.w) {
            return false;
        }
        if (center.y - h / 2 < this.arenaM.y || center.y + h / 2 > this.arenaM.y + this.arenaM.h) {
            return false;
        }
        if (Math.hypot(center.x, center.y) < 0.8) {
            return false;
        }
        for (const fighter of this.fighters) {
            const dx = Math.max(Math.abs(fighter.posM.x - center.x) - w / 2, 0);
            const dy = Math.max(Math.abs(fighter.posM.y - center.y) - h / 2, 0);
            if (Math.hypot(dx, dy) < fighter.radiusM + 0.12) {
                return false;
            }
        }
        return true;
    }

    private damageWall(wallId: number | undefined, damage: number) {
        if (wallId === undefined) {
            return;
        }
        const wall = this.walls.find((candidate) => candidate.id === wallId);
        if (!wall || !wall.breakable) {
            return;
        }
        wall.hp -= damage;
        this.playCue('wall');
        if (wall.hp <= 0) {
            this.walls = this.walls.filter((candidate) => candidate.id !== wallId);
            this.addField(this.currentPlayer, 'damping', wall.centerM, new Vec2(), 0.6, 0, 0, 0.14, 1, '碎片阻尼', new Color(185, 199, 215, 255));
        }
    }

    private addAttrEffect(owner: number, target: number, massDeltaKg: number, frictionDelta: number, chargeDeltaC: number, durationSec: number, label: string) {
        this.attrEffects.push({
            id: this.attrEffectId++,
            owner,
            target,
            massDeltaKg,
            frictionDelta,
            chargeDeltaC,
            remainingSec: Math.max(1, durationSec),
            label,
        });
    }

    private adjustChargeTowardZero(index: number, amount: number) {
        const charge = this.fighters[index].baseChargeC;
        if (Math.abs(charge) <= amount) {
            this.fighters[index].baseChargeC = 0;
        } else {
            this.fighters[index].baseChargeC = this.clamp(charge - Math.sign(charge) * amount, -5, 5);
        }
        this.playCue('electric');
    }

    private boostLatestOwnField(owner: number, multiplier: number) {
        const field = this.findLatestOwnField(owner);
        if (!field) {
            return;
        }
        field.maxForceN = this.clamp(field.maxForceN * multiplier, 0.05, 2.0);
        field.remainingSec = Math.min(5, field.remainingSec + 1);
    }

    private findLatestOwnField(owner: number) {
        const own = this.fields.filter((field) => field.owner === owner);
        if (own.length === 0) {
            return undefined;
        }
        own.sort((a, b) => b.id - a.id);
        return own[0];
    }

    private findNearestBreakableWall(pointM: Vec2, maxDistanceM: number) {
        let best: WallBody | undefined;
        let bestDist = maxDistanceM;
        for (const wall of this.walls) {
            if (!wall.breakable) {
                continue;
            }
            const dx = Math.max(Math.abs(pointM.x - wall.centerM.x) - wall.sizeM.x / 2, 0);
            const dy = Math.max(Math.abs(pointM.y - wall.centerM.y) - wall.sizeM.y / 2, 0);
            const dist = Math.hypot(dx, dy);
            if (dist < bestDist) {
                bestDist = dist;
                best = wall;
            }
        }
        return best;
    }

    private onMouseDown(event: EventMouse) {
        const point = this.toLocalPoint(event);

        if (this.hitReset(point)) {
            this.resetToStart();
            return;
        }

        if (this.phase === 'start') {
            if (this.hitPrimary(point)) {
                this.beginMatch();
            }
            return;
        }

        if (this.phase === 'roundOver') {
            if (this.hitPrimary(point)) {
                this.setupRound(this.nextRoundFirst);
            }
            return;
        }

        if (this.phase === 'matchOver') {
            if (this.hitPrimary(point)) {
                this.resetToStart();
            }
            return;
        }

        if (this.phase !== 'planning') {
            this.message = this.phase === 'settling' ? '1 秒物理结算中，双方会同时移动。' : '骰子过场中，动画结束后再结算移动。';
            return;
        }

        if (this.hitPrimary(point)) {
            const actor = this.fighters[this.currentPlayer];
            const planned = this.pendingIntents.length;
            const reason = planned > 0
                ? `${actor.name} 结束行动，本回合计划 ${planned} 张卡。`
                : `${actor.name} 跳过行动。`;
            this.endPlanning(reason);
            return;
        }

        if (this.hitDiscard(point)) {
            this.discardSelectedCard();
            return;
        }

        const cardIndex = this.hitCard(point);
        if (cardIndex >= 0) {
            this.selectedCard = cardIndex;
            this.pressedCardIndex = cardIndex;
            this.draggingCard = false;
            this.pointerDownPoint.set(point.x, point.y);
            this.aimPoint.set(point.x, point.y);
            const card = this.currentHand()[cardIndex];
            this.cardInfoText = this.cardDetails(card);
            return;
        }
    }

    private onMouseMove(event: EventMouse) {
        const point = this.toLocalPoint(event);
        this.aimPoint.set(point.x, point.y);
        if (this.phase !== 'planning' || this.pressedCardIndex < 0) {
            return;
        }
        const moved = Math.hypot(point.x - this.pointerDownPoint.x, point.y - this.pointerDownPoint.y);
        if (moved >= this.dragStartThreshold) {
            this.draggingCard = true;
        }
    }

    private onMouseUp(event: EventMouse) {
        const point = this.toLocalPoint(event);
        if (this.phase === 'planning' && this.draggingCard && this.pressedCardIndex === this.selectedCard) {
            this.queueSelectedCard(point);
        }
        this.draggingCard = false;
        this.pressedCardIndex = -1;
    }

    private draw() {
        this.drawWorld();
        this.drawHud();
        this.updateLabels();
    }

    private drawWorld() {
        const g = this.worldG;
        g.clear();
        g.fillColor = new Color(9, 13, 19, 255);
        g.rect(-640, -360, 1280, 720);
        g.fill();

        if (this.phase === 'start') {
            this.drawStartWorld(g);
            return;
        }

        const ar = this.arenaPxRect();
        const hasIce = this.fields.some((field) => (field.type === 'friction' || field.type === 'wind') && field.frictionDelta < 0);
        g.fillColor = hasIce ? new Color(20, 42, 58, 255) : new Color(21, 29, 40, 255);
        g.rect(ar.x, ar.y, ar.w, ar.h);
        g.fill();

        this.drawGrid(g, ar);
        this.drawFields(g);
        this.drawWalls(g);
        this.drawElectricFx(g);
        this.drawPendingPreviews(g);

        for (let i = 0; i < this.fighters.length; i++) {
            this.drawFighter(g, i);
        }

        if (hasIce || this.fields.some((field) => field.type === 'wind')) {
            this.drawSnow(g, ar);
        }

        g.strokeColor = new Color(112, 145, 184, 255);
        g.lineWidth = 3;
        g.rect(ar.x, ar.y, ar.w, ar.h);
        g.stroke();
    }

    private drawStartWorld(g: Graphics) {
        g.fillColor = new Color(17, 23, 34, 255);
        g.rect(-640, -360, 1280, 720);
        g.fill();

        for (let y = -320; y <= 320; y += 32) {
            for (let x = -600; x <= 600; x += 32) {
                const on = ((x + y) / 32) % 2 === 0;
                g.fillColor = on ? new Color(24, 36, 52, 255) : new Color(19, 28, 41, 255);
                g.rect(x, y, 30, 30);
                g.fill();
            }
        }

        g.fillColor = new Color(75, 168, 255, 255);
        g.rect(-166, 60, 84, 84);
        g.fill();
        g.fillColor = new Color(255, 92, 105, 255);
        g.rect(82, 60, 84, 84);
        g.fill();
        this.drawDiceFace(g, new Vec2(0, 101), this.dice || 1, 64);
        this.drawPrimaryButton(g);
    }

    private drawGrid(g: Graphics, ar: RectLike) {
        g.strokeColor = new Color(53, 72, 96, 255);
        g.lineWidth = 1;
        for (let xM = Math.ceil(this.arenaM.x); xM <= this.arenaM.x + this.arenaM.w; xM += 1) {
            const x = xM * this.pxPerM;
            g.moveTo(x, ar.y);
            g.lineTo(x, ar.y + ar.h);
        }
        for (let yM = Math.ceil(this.arenaM.y); yM <= this.arenaM.y + this.arenaM.h; yM += 1) {
            const y = yM * this.pxPerM;
            g.moveTo(ar.x, y);
            g.lineTo(ar.x + ar.w, y);
        }
        g.stroke();

        g.strokeColor = new Color(135, 154, 181, 120);
        g.lineWidth = 2;
        g.moveTo(ar.x, 0);
        g.lineTo(ar.x + ar.w, 0);
        g.moveTo(0, ar.y);
        g.lineTo(0, ar.y + ar.h);
        g.stroke();
    }

    private drawFields(g: Graphics) {
        for (const field of this.fields) {
            const p = this.worldToPx(field.positionM);
            const r = field.radiusM * this.pxPerM;
            g.fillColor = new Color(field.color.r, field.color.g, field.color.b, 34);
            g.circle(p.x, p.y, r);
            g.fill();
            g.strokeColor = new Color(field.color.r, field.color.g, field.color.b, 150);
            g.lineWidth = 2;
            g.circle(p.x, p.y, r);
            g.stroke();

            if (field.type === 'wind') {
                g.strokeColor = new Color(170, 239, 255, 220);
                g.lineWidth = 4;
                g.moveTo(p.x - field.direction.x * 28, p.y - field.direction.y * 28);
                g.lineTo(p.x + field.direction.x * 52, p.y + field.direction.y * 52);
                g.stroke();
            } else if (field.type === 'charge') {
                g.strokeColor = field.sourceChargeC >= 0 ? new Color(255, 224, 102, 235) : new Color(145, 196, 255, 235);
                g.lineWidth = 4;
                g.circle(p.x, p.y, 15);
                g.stroke();
                this.drawPlusMinus(g, p.x, p.y, field.sourceChargeC >= 0);
            }
        }
    }

    private drawWalls(g: Graphics) {
        for (const wall of this.walls) {
            const p = this.worldToPx(wall.centerM);
            const w = wall.sizeM.x * this.pxPerM;
            const h = wall.sizeM.y * this.pxPerM;
            g.fillColor = wall.color;
            g.rect(p.x - w / 2, p.y - h / 2, w, h);
            g.fill();
            g.strokeColor = wall.breakable ? new Color(235, 229, 210, 255) : new Color(141, 161, 189, 255);
            g.lineWidth = wall.breakable ? 2 : 1.5;
            g.rect(p.x - w / 2, p.y - h / 2, w, h);
            g.stroke();

            if (wall.breakable) {
                g.strokeColor = new Color(255, 238, 180, 160);
                g.lineWidth = 2;
                const ratio = this.clamp(wall.hp / wall.maxHp, 0, 1);
                g.moveTo(p.x - w / 2, p.y + h / 2 + 5);
                g.lineTo(p.x - w / 2 + w * ratio, p.y + h / 2 + 5);
                g.stroke();
            }
        }
    }

    private drawFighter(g: Graphics, index: number) {
        const fighter = this.fighters[index];
        const stats = this.effectiveStats(index);
        const p = this.worldToPx(fighter.posM);
        const r = fighter.radiusM * this.pxPerM;

        g.fillColor = new Color(0, 0, 0, 90);
        g.circle(p.x + 5, p.y - 7, r + 4);
        g.fill();

        g.fillColor = fighter.color;
        g.circle(p.x, p.y, r);
        g.fill();

        g.strokeColor = this.currentPlayer === index && this.phase === 'planning' ? new Color(255, 232, 125, 255) : new Color(230, 236, 246, 155);
        g.lineWidth = this.currentPlayer === index && this.phase === 'planning' ? 4 : 2;
        g.circle(p.x, p.y, r + 3);
        g.stroke();

        const force = this.lastForces[index];
        const forceLen = Math.hypot(force.x, force.y);
        if (forceLen > 0.03) {
            const fx = force.x / forceLen;
            const fy = force.y / forceLen;
            g.strokeColor = new Color(255, 248, 190, 210);
            g.lineWidth = 3;
            g.moveTo(p.x, p.y);
            g.lineTo(p.x + fx * Math.min(82, forceLen * 42), p.y + fy * Math.min(82, forceLen * 42));
            g.stroke();
        }

        const speed = Math.hypot(fighter.velMps.x, fighter.velMps.y);
        if (speed > 0.05) {
            g.strokeColor = new Color(255, 255, 255, 130);
            g.lineWidth = 2;
            g.moveTo(p.x, p.y);
            g.lineTo(p.x + fighter.velMps.x * 28, p.y + fighter.velMps.y * 28);
            g.stroke();
        }

        if (Math.abs(stats.chargeC) > 0.01) {
            g.strokeColor = stats.chargeC > 0 ? new Color(255, 229, 116, 180) : new Color(135, 194, 255, 180);
            g.lineWidth = 2;
            g.circle(p.x, p.y, r + 9);
            g.stroke();
        }
    }

    private drawElectricFx(g: Graphics) {
        const s0 = this.effectiveStats(0);
        const s1 = this.effectiveStats(1);
        const dist = Math.hypot(this.fighters[0].posM.x - this.fighters[1].posM.x, this.fighters[0].posM.y - this.fighters[1].posM.y);
        if (Math.abs(s0.chargeC * s1.chargeC) > 0.1 && dist < 5.2) {
            this.drawLightning(g, this.worldToPx(this.fighters[0].posM), this.worldToPx(this.fighters[1].posM), new Color(116, 202, 255, 170));
        }

        for (const field of this.fields) {
            if (field.type !== 'charge') {
                continue;
            }
            const source = this.worldToPx(field.positionM);
            for (let i = 0; i < this.fighters.length; i++) {
                const fighter = this.fighters[i];
                const d = Math.hypot(fighter.posM.x - field.positionM.x, fighter.posM.y - field.positionM.y);
                if (d < field.radiusM * 0.82) {
                    this.drawLightning(g, source, this.worldToPx(fighter.posM), new Color(255, 238, 130, 120));
                }
            }
        }
    }

    private drawLightning(g: Graphics, from: Vec2, to: Vec2, color: Color) {
        const segments = 6;
        g.strokeColor = color;
        g.lineWidth = 2;
        for (let i = 0; i <= segments; i++) {
            const t = i / segments;
            const x = from.x + (to.x - from.x) * t;
            const y = from.y + (to.y - from.y) * t;
            const jitter = i === 0 || i === segments ? 0 : Math.sin(this.snowTick * 21 + i * 3.7) * 8;
            const nx = -(to.y - from.y);
            const ny = to.x - from.x;
            const len = Math.max(0.001, Math.hypot(nx, ny));
            const px = x + (nx / len) * jitter;
            const py = y + (ny / len) * jitter;
            if (i === 0) {
                g.moveTo(px, py);
            } else {
                g.lineTo(px, py);
            }
        }
        g.stroke();
    }

    private drawPendingPreviews(g: Graphics) {
        if (this.phase !== 'planning') {
            return;
        }
        for (const intent of this.pendingIntents) {
            const p = this.worldToPx(intent.positionM);
            g.strokeColor = new Color(255, 255, 255, 90);
            g.lineWidth = 2;
            g.circle(p.x, p.y, 14);
            g.stroke();
            if (intent.card.kind === 'windField') {
                g.moveTo(p.x, p.y);
                g.lineTo(p.x + intent.direction.x * 46, p.y + intent.direction.y * 46);
                g.stroke();
            }
        }

        if (this.draggingCard && this.selectedCard >= 0 && this.inArenaPx(this.aimPoint)) {
            const card = this.currentHand()[this.selectedCard];
            const p = this.aimPoint;
            g.strokeColor = new Color(card.color.r, card.color.g, card.color.b, 160);
            g.lineWidth = 2;
            const radiusM = card.values.radiusM || 0.35;
            g.circle(p.x, p.y, radiusM * this.pxPerM);
            g.stroke();
        }
    }

    private drawSnow(g: Graphics, ar: RectLike) {
        g.fillColor = new Color(176, 232, 255, 95);
        for (let i = 0; i < 38; i++) {
            const x = ar.x + ((i * 67 + this.snowTick * 28) % ar.w);
            const y = ar.y + ((i * 43 - this.snowTick * 36) % ar.h + ar.h) % ar.h;
            g.circle(x, y, i % 3 === 0 ? 2.2 : 1.4);
            g.fill();
        }
    }

    private drawHud() {
        const g = this.hudG;
        g.clear();

        g.fillColor = new Color(20, 27, 38, 238);
        g.rect(-640, 250, 1280, 110);
        g.fill();

        g.fillColor = new Color(15, 22, 32, 242);
        g.rect(-640, -360, 1280, 132);
        g.fill();

        if (this.phase !== 'start') {
            this.drawPanel(g, -628, 156, 268, 104, new Color(24, 48, 75, 235), this.currentPlayer === 0 && this.phase === 'planning');
            this.drawPanel(g, 360, 156, 268, 104, new Color(78, 31, 39, 235), this.currentPlayer === 1 && this.phase === 'planning');
        }

        this.drawButton(g, this.resetRect(), new Color(48, 60, 76, 255), true);
        this.drawPrimaryButton(g);
        if (this.phase === 'planning') {
            this.drawButton(g, this.discardRect(), this.selectedCard >= 0 ? new Color(65, 71, 88, 255) : new Color(42, 47, 56, 255), this.selectedCard >= 0);
        }

        if (this.phase === 'planning') {
            const hand = this.currentHand();
            for (let i = 0; i < this.maxHandSize; i++) {
                const r = this.cardRect(i);
                const card = hand[i];
                const selected = i === this.selectedCard;
                g.fillColor = !card ? new Color(24, 30, 40, 255) : selected ? new Color(255, 235, 151, 255) : new Color(35, 44, 58, 255);
                g.rect(r.x, r.y, r.w, r.h);
                g.fill();

                if (card) {
                    g.fillColor = card.color;
                    g.rect(r.x + 4, r.y + r.h - 10, r.w - 8, 6);
                    g.fill();
                }

                g.strokeColor = !card ? new Color(55, 66, 84, 255) : selected ? new Color(255, 247, 209, 255) : new Color(88, 105, 130, 255);
                g.lineWidth = selected ? 3 : 1.5;
                g.rect(r.x, r.y, r.w, r.h);
                g.stroke();
            }
        }

        if (this.draggingCard && this.selectedCard >= 0) {
            const card = this.currentHand()[this.selectedCard];
            if (card) {
                const x = this.aimPoint.x - this.cardW / 2;
                const y = this.aimPoint.y - this.cardH / 2;
                g.fillColor = new Color(255, 235, 151, 220);
                g.rect(x, y, this.cardW, this.cardH);
                g.fill();
                g.fillColor = card.color;
                g.rect(x + 4, y + this.cardH - 10, this.cardW - 8, 6);
                g.fill();
                g.strokeColor = this.inArenaPx(this.aimPoint) ? new Color(255, 247, 209, 255) : new Color(255, 142, 142, 255);
                g.lineWidth = 3;
                g.rect(x, y, this.cardW, this.cardH);
                g.stroke();
            }
        }
    }

    private drawPanel(g: Graphics, x: number, y: number, w: number, h: number, color: Color, active: boolean) {
        g.fillColor = color;
        g.rect(x, y, w, h);
        g.fill();
        g.strokeColor = active ? new Color(255, 232, 125, 255) : new Color(88, 105, 130, 255);
        g.lineWidth = active ? 3 : 1.5;
        g.rect(x, y, w, h);
        g.stroke();
    }

    private drawButton(g: Graphics, rect: RectLike, color: Color, enabled: boolean) {
        g.fillColor = color;
        g.rect(rect.x, rect.y, rect.w, rect.h);
        g.fill();
        g.strokeColor = enabled ? new Color(178, 193, 214, 255) : new Color(91, 103, 118, 255);
        g.lineWidth = 2;
        g.rect(rect.x, rect.y, rect.w, rect.h);
        g.stroke();
    }

    private drawPrimaryButton(g: Graphics) {
        const rect = this.primaryRect();
        const enabled = this.phase === 'start' || this.phase === 'planning' || this.phase === 'roundOver' || this.phase === 'matchOver';
        const color = enabled ? new Color(60, 69, 85, 255) : new Color(42, 47, 56, 255);
        this.drawButton(g, rect, color, enabled);
    }

    private drawDiceFace(g: Graphics, center: Vec2, value: number, size: number) {
        const x = center.x - size / 2;
        const y = center.y - size / 2;
        g.fillColor = new Color(238, 244, 255, 255);
        g.rect(x, y, size, size);
        g.fill();
        g.strokeColor = new Color(34, 45, 62, 255);
        g.lineWidth = 4;
        g.rect(x, y, size, size);
        g.stroke();

        const dots: Array<[number, number]> = [];
        const a = size * 0.23;
        const b = size * 0.50;
        const c = size * 0.77;
        if ([1, 3, 5].indexOf(value) >= 0) dots.push([b, b]);
        if (value >= 2) dots.push([a, c], [c, a]);
        if (value >= 4) dots.push([a, a], [c, c]);
        if (value === 6) dots.push([a, b], [c, b]);
        g.fillColor = new Color(31, 42, 58, 255);
        for (const dot of dots) {
            g.circle(x + dot[0], y + dot[1], size * 0.06);
            g.fill();
        }
    }

    private drawPlusMinus(g: Graphics, x: number, y: number, positive: boolean) {
        g.strokeColor = positive ? new Color(255, 235, 120, 255) : new Color(145, 196, 255, 255);
        g.lineWidth = 3;
        g.moveTo(x - 7, y);
        g.lineTo(x + 7, y);
        if (positive) {
            g.moveTo(x, y - 7);
            g.lineTo(x, y + 7);
        }
        g.stroke();
    }

    private updateLabels() {
        const primary = this.primaryRect();
        this.labels.action.node.setPosition(primary.x + primary.w / 2, primary.y + primary.h / 2);
        const actionTransform = this.labels.action.node.getComponent(UITransform);
        if (actionTransform) {
            actionTransform.setContentSize(primary.w, primary.h);
        }

        this.labels.title.string = this.phase === 'start' ? '力学大乱斗 v4.0' : `力学大乱斗 v4.0  第 ${this.roundNumber} 局`;
        this.labels.message.string = this.message;
        this.labels.reset.string = '重开';
        this.labels.action.string = this.primaryLabel();
        this.labels.discard.string = this.phase === 'planning' ? `弃牌 ${this.discardsThisTurn}/${this.maxDiscardsPerTurn}` : '';

        if (this.phase === 'start') {
            this.labels.turn.string = '三局两胜';
            this.labels.timer.string = '开局掷骰';
            this.labels.field.string = '点数 1-3 牛顿先手；点数 4-6 麦克斯韦先手';
            this.labels.p0.string = '';
            this.labels.p1.string = '';
            this.labels.hint.string = '';
            this.labels.cardInfo.string = '';
        } else {
            const actor = this.fighters[this.currentPlayer];
            this.labels.turn.string = `局分 ${this.roundWins[0]}:${this.roundWins[1]}  行动 ${this.actionTurnCount}/${this.maxActionTurns}  当前：${actor.name}`;
            this.labels.timer.string = this.phase === 'planning'
                ? `倒计时 ${Math.ceil(this.turnTimer)} s / 计划 ${this.pendingIntents.length} 张 / 骰子点数 ${this.dice}`
                : this.phase === 'settling'
                    ? `1 秒结算剩余 ${Math.max(0, this.settleRemaining).toFixed(2)} s / 骰子点数 ${this.dice}`
                    : `骰子点数 ${this.dice}`;
            this.labels.field.string = this.sceneText();
            this.labels.p0.string = this.playerText(0);
            this.labels.p1.string = this.playerText(1);
            this.labels.cardInfo.string = this.cardInfoText || '单击卡牌查看具体数值和单位；拖到实验台内释放，只加入计划队列，不会立刻改变正式物理状态。';
            this.labels.hint.string = this.hintText();
        }

        for (let i = 0; i < this.cardLabels.length; i++) {
            const card = this.phase === 'planning' ? this.currentHand()[i] : undefined;
            this.cardLabels[i].string = card ? `${i + 1}\n${card.shortName}` : '';
            this.cardLabels[i].color = i === this.selectedCard ? new Color(32, 27, 18, 255) : new Color(238, 242, 249, 255);
        }

        this.labels.discard.node.active = this.phase === 'planning';
        for (const label of this.cardLabels) {
            label.node.active = this.phase === 'planning';
        }
    }

    private primaryLabel() {
        if (this.phase === 'start') return '开始';
        if (this.phase === 'roundOver') return '下一局';
        if (this.phase === 'matchOver') return '重开';
        if (this.phase === 'planning') return this.pendingIntents.length > 0 ? '结束' : '跳过';
        if (this.phase === 'firstDice' || this.phase === 'turnDice') return '掷骰';
        return '结算';
    }

    private sceneText() {
        const fields = this.fields.map((field) => `${field.label} ${field.remainingSec}s`).join('；') || '无场源';
        const pending = this.pendingIntents.map((intent) => intent.card.name).join('、') || '无计划';
        return `地图 12.0 m x 6.8 m；场源：${fields}；墙体 ${this.walls.length}；本回合计划：${pending}`;
    }

    private playerText(index: number) {
        const f = this.fighters[index];
        const stats = this.effectiveStats(index);
        const speed = Math.hypot(f.velMps.x, f.velMps.y);
        const momentum = stats.massKg * speed;
        const force = this.lastForces[index];
        const forceMag = Math.hypot(force.x, force.y);
        const handCount = this.hands[index]?.length || 0;
        return `${f.name}  局分 ${this.roundWins[index]}  手牌 ${handCount}/${this.maxHandSize}\n` +
            `位置 (${f.posM.x.toFixed(2)}, ${f.posM.y.toFixed(2)}) m  速度 ${speed.toFixed(2)} m/s\n` +
            `质量 ${stats.massKg.toFixed(2)} kg  摩擦 ${stats.friction.toFixed(2)}  电荷 ${stats.chargeC.toFixed(2)} C\n` +
            `合力 ${forceMag.toFixed(2)} N  动量 ${momentum.toFixed(2)} kg·m/s`;
    }

    private hintText() {
        if (this.phase === 'firstDice') {
            return '开局骰子动画中。点数 1-3 牛顿先手，点数 4-6 麦克斯韦先手。';
        }
        if (this.phase === 'turnDice') {
            return '回合末骰子过场中。动画结束后，计划效果才转为正式状态并开始移动。';
        }
        if (this.phase === 'settling') {
            return '统一结算中：所有新旧有效场源、属性、墙体一起作用，双方按合力移动 1 秒。';
        }
        if (this.phase === 'roundOver') {
            return '单局结束。点击下一局继续，整场为三局两胜。';
        }
        if (this.phase === 'matchOver') {
            return '整场结束。点击重开回到开始界面。';
        }
        const selected = this.currentHand()[this.selectedCard];
        return selected
            ? `已选：${selected.name}。拖到实验台内释放后会被消耗，并加入计划队列；可以继续使用多张卡。`
            : `${this.fighters[this.currentPlayer].name} 行动中。每回合最多 120 秒，可使用多张卡，也可弃牌 ${this.maxDiscardsPerTurn} 张。`;
    }

    private cardDetails(card: CardDef) {
        return [
            `${card.name}｜${card.desc}`,
            `类型：${card.family} / ${this.targetText(card.targetMode)}｜生效：结束行动 + 骰子过场后`,
            `持续：${card.durationSec > 0 ? `${card.durationSec} s` : '本次结算前一次性'}｜${card.unitText}`,
            `边界：质量 0.5-5.0 kg；电荷 -5 到 5 C；摩擦 0.02-0.80；单场源作用力不超过 2.0 N`,
        ].join('\n');
    }

    private intentDetails(intent: CardIntent) {
        return [
            `${intent.card.name} 已进入计划队列`,
            intent.summary,
            '当前尚未改变角色或场景正式状态；回合结束并完成骰子动画后，才参与 1 秒统一结算。',
        ].join('\n');
    }

    private intentSummary(card: CardDef, positionM: Vec2, direction: Vec2, wall?: WallBody) {
        switch (card.kind) {
            case 'windField':
                return `将在 (${positionM.x.toFixed(2)}, ${positionM.y.toFixed(2)}) m 创建风场，方向 (${direction.x.toFixed(2)}, ${direction.y.toFixed(2)})，${card.unitText}`;
            case 'chargeField':
                return `将在 (${positionM.x.toFixed(2)}, ${positionM.y.toFixed(2)}) m 创建固定电荷点，${card.unitText}`;
            case 'frictionZone':
            case 'dampingZone':
                return `将在 (${positionM.x.toFixed(2)}, ${positionM.y.toFixed(2)}) m 创建区域，${card.unitText}`;
            case 'wallCreate':
                return `将在 (${positionM.x.toFixed(2)}, ${positionM.y.toFixed(2)}) m 创建刚性墙体，${card.unitText}`;
            case 'wallBreak':
                return wall ? `将对墙体 #${wall.id} 造成 ${card.values.damage} 点耐久削减。` : '未选中墙体。';
            case 'fieldBoost':
                return `将强化最近的己方场源，强度乘 ${card.values.multiplier.toFixed(1)}，最高 2.0 N。`;
            default:
                return `${this.targetText(card.targetMode)}：${card.unitText}`;
        }
    }

    private targetText(target: TargetMode) {
        switch (target) {
            case 'self': return '目标自身';
            case 'opponent': return '目标对手';
            case 'arena': return '地图位置/方向';
            case 'wall': return '目标墙体';
            case 'ownField': return '己方场源';
        }
    }

    private playSettlementCue() {
        if (this.fields.some((field) => field.type === 'charge')) {
            this.playCue('electric');
        } else if (this.fields.some((field) => field.type === 'wind' || field.type === 'friction')) {
            this.playCue('wind');
        } else {
            this.playCue('click');
        }
    }

    private playCue(kind: SoundCue) {
        const Ctor = (globalThis as any).AudioContext || (globalThis as any).webkitAudioContext;
        if (!Ctor) {
            return;
        }
        try {
            if (!this.audioCtx) {
                this.audioCtx = new Ctor();
            }
            const ctx = this.audioCtx;
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            const now = ctx.currentTime;
            const config: Record<SoundCue, [number, number, string]> = {
                dice: [220, 0.16, 'triangle'],
                wind: [110, 0.32, 'sawtooth'],
                electric: [760, 0.10, 'square'],
                wall: [150, 0.12, 'sine'],
                math: [520, 0.12, 'triangle'],
                click: [330, 0.06, 'sine'],
            };
            const [freq, duration, type] = config[kind];
            osc.type = type as any;
            osc.frequency.setValueAtTime(freq, now);
            if (kind === 'electric') {
                osc.frequency.exponentialRampToValueAtTime(1120, now + duration);
            }
            gain.gain.setValueAtTime(0.0001, now);
            gain.gain.exponentialRampToValueAtTime(kind === 'wind' ? 0.025 : 0.045, now + 0.02);
            gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.start(now);
            osc.stop(now + duration + 0.02);
        } catch {
            this.audioCtx = null;
        }
    }

    private rollDice() {
        return 1 + Math.floor(Math.random() * 6);
    }

    private worldToPx(posM: Vec2) {
        return new Vec2(posM.x * this.pxPerM, posM.y * this.pxPerM);
    }

    private pxToWorld(posPx: Vec2) {
        return new Vec2(posPx.x / this.pxPerM, posPx.y / this.pxPerM);
    }

    private arenaPxRect(): RectLike {
        return {
            x: this.arenaM.x * this.pxPerM,
            y: this.arenaM.y * this.pxPerM,
            w: this.arenaM.w * this.pxPerM,
            h: this.arenaM.h * this.pxPerM,
        };
    }

    private inArenaPx(point: Vec2) {
        const ar = this.arenaPxRect();
        return point.x >= ar.x && point.x <= ar.x + ar.w && point.y >= ar.y && point.y <= ar.y + ar.h;
    }

    private toLocalPoint(event: EventMouse) {
        const p = event.getUILocation();
        const local = this.canvas.convertToNodeSpaceAR(new Vec3(p.x, p.y, 0));
        return new Vec2(local.x, local.y);
    }

    private directionBetween(from: Vec2, to: Vec2) {
        return this.normalized(new Vec2(to.x - from.x, to.y - from.y), new Vec2(1, 0));
    }

    private normalized(value: Vec2, fallback: Vec2) {
        const len = Math.hypot(value.x, value.y);
        if (len < 0.001) {
            return this.cloneVec(fallback);
        }
        return new Vec2(value.x / len, value.y / len);
    }

    private cloneVec(value: Vec2) {
        return new Vec2(value.x, value.y);
    }

    private clamp(value: number, min: number, max: number) {
        return Math.max(min, Math.min(max, value));
    }

    private hitCard(point: Vec2) {
        if (this.phase !== 'planning') {
            return -1;
        }
        const hand = this.currentHand();
        for (let i = 0; i < hand.length; i++) {
            const r = this.cardRect(i);
            if (point.x >= r.x && point.x <= r.x + r.w && point.y >= r.y && point.y <= r.y + r.h) {
                return i;
            }
        }
        return -1;
    }

    private hitReset(point: Vec2) {
        const r = this.resetRect();
        return point.x >= r.x && point.x <= r.x + r.w && point.y >= r.y && point.y <= r.y + r.h;
    }

    private hitPrimary(point: Vec2) {
        const r = this.primaryRect();
        return point.x >= r.x && point.x <= r.x + r.w && point.y >= r.y && point.y <= r.y + r.h;
    }

    private hitDiscard(point: Vec2) {
        const r = this.discardRect();
        return point.x >= r.x && point.x <= r.x + r.w && point.y >= r.y && point.y <= r.y + r.h;
    }

    private cardRect(index: number): RectLike {
        const total = this.maxHandSize * this.cardW + (this.maxHandSize - 1) * this.cardGap;
        return {
            x: -total / 2 + index * (this.cardW + this.cardGap),
            y: -340,
            w: this.cardW,
            h: this.cardH,
        };
    }

    private resetRect(): RectLike {
        return { x: 525, y: 292, w: 92, h: 38 };
    }

    private primaryRect(): RectLike {
        if (this.phase === 'start') {
            return { x: -120, y: -50, w: 240, h: 58 };
        }
        return { x: 525, y: 246, w: 92, h: 38 };
    }

    private discardRect(): RectLike {
        return { x: 411, y: 246, w: 92, h: 38 };
    }
}
