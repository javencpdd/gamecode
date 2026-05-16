import { _decorator, Color, Component, EventMouse, Graphics, input, Input, Label, Node, profiler, UITransform, Vec2, Vec3 } from 'cc';

const { ccclass } = _decorator;

type CardKind =
    | 'impulse'
    | 'reaction'
    | 'transfer'
    | 'brake'
    | 'repel'
    | 'attract'
    | 'wall'
    | 'gyro'
    | 'zeroFriction'
    | 'slope'
    | 'return'
    | 'chaos';

type TurnState = 'aim' | 'resolve';

interface CardDef {
    name: string;
    shortName: string;
    hint: string;
    kind: CardKind;
    power: number;
    color: Color;
}

interface Fighter {
    name: string;
    pos: Vec2;
    vel: Vec2;
    radius: number;
    mass: number;
    charge: number;
    stability: number;
    stabilityTurns: number;
    shield: number;
    shieldTurns: number;
    score: number;
    color: Color;
}

interface RectLike {
    x: number;
    y: number;
    w: number;
    h: number;
}

@ccclass('MechanicsBrawlGame')
export class MechanicsBrawlGame extends Component {
    private canvas!: UITransform;
    private worldG!: Graphics;
    private hudG!: Graphics;
    private labels: Record<string, Label> = {};
    private cardLabels: Label[] = [];
    private fighters: Fighter[] = [];
    private cards: CardDef[] = [];
    private decks: CardDef[][] = [[], []];
    private hands: CardDef[][] = [[], []];
    private currentPlayer = 0;
    private selectedCard = -1;
    private dice = 1;
    private turnCount = 1;
    private cardsPlayedThisTurn = 0;
    private turnState: TurnState = 'aim';
    private resolveTimer = 0;
    private aiming = false;
    private draggingCard = false;
    private pressedCardIndex = -1;
    private aimPoint = new Vec2();
    private pointerDownPoint = new Vec2();
    private frictionTurns = 0;
    private slopeTurns = 0;
    private slopeForce = new Vec2(58, -32);
    private cardInfoText = '';
    private message = '';
    private gameOver = false;

    private readonly arena: RectLike = { x: -540, y: -225, w: 1080, h: 450 };
    private readonly ringOutMargin = 72;
    private readonly openingHandSize = 4;
    private readonly maxHandSize = 6;
    private readonly cardsDrawnPerTurn = 2;
    private readonly cardW = 108;
    private readonly cardH = 66;
    private readonly cardGap = 11;
    private readonly maxResolveTime = 4.5;
    private readonly dragStartThreshold = 12;

    onLoad() {
        this.node.removeAllChildren();
        this.canvas = this.node.getComponent(UITransform) || this.node.addComponent(UITransform);
        this.canvas.setContentSize(1280, 720);
        this.cards = this.createDeck();
        this.decks = this.createPlayerDecks();
        this.createLayers();
        this.createLabels();
        this.resetMatch();
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
        const dt = Math.min(deltaTime, 1 / 30);
        if (!this.gameOver && this.turnState === 'resolve') {
            this.stepPhysics(dt);
            this.updateResolve(dt);
        }
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
        this.makeLabel('title', 0, 328, 520, 36, 24, new Color(244, 247, 255, 255));
        this.makeLabel('turn', -265, 292, 250, 28, 18, new Color(228, 239, 255, 255));
        this.makeLabel('dice', 0, 292, 170, 28, 18, new Color(255, 219, 126, 255));
        this.makeLabel('field', 0, 236, 780, 34, 13, new Color(189, 255, 218, 255));
        this.makeLabel('message', 0, 266, 720, 30, 17, new Color(206, 226, 255, 255));
        this.makeLabel('p0', -502, 232, 250, 86, 13, new Color(206, 233, 255, 255));
        this.makeLabel('p1', 502, 232, 250, 86, 13, new Color(255, 218, 218, 255));
        this.makeLabel('hint', 0, -168, 900, 22, 13, new Color(178, 190, 205, 255));
        this.makeLabel('cardInfo', 0, -226, 1120, 76, 12, new Color(228, 236, 248, 255));
        this.makeLabel('reset', 571, 311, 88, 28, 16, new Color(238, 244, 255, 255));
        this.makeLabel('skip', 571, 265, 88, 28, 16, new Color(238, 244, 255, 255));

        for (let i = 0; i < this.maxHandSize; i++) {
            const r = this.cardRect(i);
            const label = this.makeLabel(`card_${i}`, r.x + r.w / 2, r.y + r.h / 2 - 2, r.w - 6, r.h - 8, 14, Color.WHITE);
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

    private createDeck(): CardDef[] {
        return [
            { name: '矢量冲击', shortName: '矢量\n冲击', hint: '沿拖拽方向给当前角色一次冲量，拖得越远力越大。', kind: 'impulse', power: 220, color: new Color(63, 151, 255, 255) },
            { name: '反作用盾', shortName: '反作\n用盾', hint: '获得持续若干回合的护盾，并朝拖拽反方向获得小冲量。', kind: 'reaction', power: 135, color: new Color(98, 205, 255, 255) },
            { name: '动量转移', shortName: '动量\n转移', hint: '把自己的部分速度和拖拽方向的额外推力转给对手。', kind: 'transfer', power: 150, color: new Color(119, 232, 181, 255) },
            { name: '惯性刹车', shortName: '惯性\n刹车', hint: '降低自身速度，并获得按回合结算的稳定性。', kind: 'brake', power: 0, color: new Color(166, 213, 122, 255) },
            { name: '电荷推斥', shortName: '电荷\n推斥', hint: '按拖拽距离添加同极电荷，并沿拖拽方向推开对手。', kind: 'repel', power: 185, color: new Color(255, 204, 83, 255) },
            { name: '极性吸引', shortName: '极性\n吸引', hint: '按拖拽距离添加异极电荷，并沿拖拽方向牵引对手。', kind: 'attract', power: 170, color: new Color(255, 158, 78, 255) },
            { name: '力场屏障', shortName: '力场\n屏障', hint: '获得持续若干回合的稳定和护盾，并按拖拽方向侧推。', kind: 'wall', power: 145, color: new Color(190, 144, 255, 255) },
            { name: '陀螺稳定', shortName: '陀螺\n稳定', hint: '降低自身速度，获得按回合结算的高稳定性。', kind: 'gyro', power: 0, color: new Color(151, 168, 255, 255) },
            { name: '摩擦归零', shortName: '摩擦\n归零', hint: '接下来若干回合全场更滑，并沿拖拽方向施加轻推。', kind: 'zeroFriction', power: 120, color: new Color(94, 229, 214, 255) },
            { name: '冰面斜坡', shortName: '冰面\n斜坡', hint: '接下来若干回合生成沿拖拽方向的场力。', kind: 'slope', power: 0, color: new Color(132, 218, 255, 255) },
            { name: '回场牵引', shortName: '回场\n牵引', hint: '把当前角色朝实验台中心牵引，偏防守。', kind: 'return', power: 175, color: new Color(251, 180, 229, 255) },
            { name: '实验误差', shortName: '实验\n误差', hint: '骰子点数决定一次较温和的随机扰动。', kind: 'chaos', power: 210, color: new Color(255, 118, 126, 255) },
        ];
    }

    private createPlayerDecks(): CardDef[][] {
        const byKind = new Map<CardKind, CardDef>();
        for (const card of this.cards) {
            byKind.set(card.kind, card);
        }
        const pick = (...kinds: CardKind[]) => kinds.map((kind) => byKind.get(kind)!);

        return [
            pick('impulse', 'reaction', 'brake', 'wall', 'gyro', 'return'),
            pick('transfer', 'repel', 'attract', 'zeroFriction', 'slope', 'chaos'),
        ];
    }

    private resetMatch() {
        this.fighters = [
            {
                name: '艾萨克',
                pos: new Vec2(-245, 0),
                vel: new Vec2(),
                radius: 30,
                mass: 1,
                charge: 1,
                stability: 0,
                stabilityTurns: 0,
                shield: 0,
                shieldTurns: 0,
                score: 0,
                color: new Color(66, 163, 255, 255),
            },
            {
                name: '麦克斯韦',
                pos: new Vec2(245, 0),
                vel: new Vec2(),
                radius: 30,
                mass: 1,
                charge: -1,
                stability: 0,
                stabilityTurns: 0,
                shield: 0,
                shieldTurns: 0,
                score: 0,
                color: new Color(255, 92, 105, 255),
            },
        ];
        this.currentPlayer = 0;
        this.selectedCard = -1;
        this.draggingCard = false;
        this.pressedCardIndex = -1;
        this.turnState = 'aim';
        this.resolveTimer = 0;
        this.turnCount = 1;
        this.cardsPlayedThisTurn = 0;
        this.dice = 1;
        this.dealOpeningHands();
        const drawn = this.drawTurnCards(this.currentPlayer);
        this.frictionTurns = 0;
        this.slopeTurns = 0;
        this.cardInfoText = '';
        this.gameOver = false;
        this.message = `回合开始，${this.fighters[this.currentPlayer].name} 抽 ${drawn} 张。可以连续出牌，或点跳过交给对手。`;
    }

    private resetRound(winnerIndex: number, reason = '') {
        this.fighters[0].pos.set(-245, 0);
        this.fighters[1].pos.set(245, 0);
        this.fighters[0].vel.set(0, 0);
        this.fighters[1].vel.set(0, 0);
        this.fighters[0].stability = 0;
        this.fighters[1].stability = 0;
        this.fighters[0].stabilityTurns = 0;
        this.fighters[1].stabilityTurns = 0;
        this.fighters[0].shield = 0;
        this.fighters[1].shield = 0;
        this.fighters[0].shieldTurns = 0;
        this.fighters[1].shieldTurns = 0;
        this.frictionTurns = 0;
        this.slopeTurns = 0;
        this.currentPlayer = winnerIndex;
        this.selectedCard = -1;
        this.aiming = false;
        this.draggingCard = false;
        this.pressedCardIndex = -1;
        this.turnState = 'aim';
        this.resolveTimer = 0;
        this.cardsPlayedThisTurn = 0;
        this.dealOpeningHands();
        const drawn = this.drawTurnCards(this.currentPlayer);
        this.cardInfoText = '';
        this.message = `${reason}${this.fighters[this.currentPlayer].name} 开始新回合，抽 ${drawn} 张。可以连续出牌。`;
    }

    private dealOpeningHands() {
        this.hands = [[], []];
        for (let playerIndex = 0; playerIndex < 2; playerIndex++) {
            for (let i = 0; i < this.openingHandSize; i++) {
                this.hands[playerIndex].push(this.drawCardForPlayer(playerIndex));
            }
        }
    }

    private currentHand() {
        return this.hands[this.currentPlayer] || [];
    }

    private drawCardForPlayer(playerIndex: number, avoidCard?: CardDef) {
        const deck = this.decks[playerIndex] || this.cards;
        const hand = this.hands[playerIndex] || [];
        let pool = deck.filter((card) => hand.indexOf(card) < 0 && card !== avoidCard);
        if (pool.length === 0) {
            pool = deck.filter((card) => card !== avoidCard);
        }
        if (pool.length === 0) {
            pool = deck;
        }
        return pool[Math.floor(Math.random() * pool.length)];
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

    private consumePlayedCard(playerIndex: number, handIndex: number) {
        const hand = this.hands[playerIndex];
        hand.splice(handIndex, 1);
    }

    private stepPhysics(dt: number) {
        for (const fighter of this.fighters) {
            if (this.slopeTurns > 0) {
                fighter.vel.x += this.slopeForce.x * dt;
                fighter.vel.y += this.slopeForce.y * dt;
            }

            const drag = this.frictionTurns > 0 ? 0.991 : 0.976;
            const damp = Math.pow(drag, dt * 60);
            fighter.vel.x *= damp;
            fighter.vel.y *= damp;
            fighter.pos.x += fighter.vel.x * dt;
            fighter.pos.y += fighter.vel.y * dt;
        }

        this.resolveCollision();
        this.checkRingOut();
    }

    private updateResolve(dt: number) {
        if (this.turnState !== 'resolve' || this.gameOver) {
            return;
        }

        this.resolveTimer += dt;
        const totalSpeed = this.fighters.reduce((sum, fighter) => sum + Math.hypot(fighter.vel.x, fighter.vel.y), 0);
        const settled = this.resolveTimer > 0.85 && totalSpeed < 34;
        if (settled || this.resolveTimer >= this.maxResolveTime) {
            for (const fighter of this.fighters) {
                if (Math.hypot(fighter.vel.x, fighter.vel.y) < 40) {
                    fighter.vel.set(0, 0);
                }
            }
            this.finishCardResolution();
        }
    }

    private finishCardResolution() {
        const actor = this.fighters[this.currentPlayer];
        this.selectedCard = -1;
        this.aiming = false;
        this.draggingCard = false;
        this.pressedCardIndex = -1;
        this.turnState = 'aim';
        this.resolveTimer = 0;

        if (this.currentHand().length === 0) {
            this.endTurn(`${actor.name} 手牌已空，本回合共使用 ${this.cardsPlayedThisTurn} 张卡。`);
            return;
        }

        this.message = `${actor.name} 本回合已使用 ${this.cardsPlayedThisTurn} 张卡。可以继续出牌，或点击结束交给对手。`;
    }

    private endTurn(reason = '') {
        this.currentPlayer = 1 - this.currentPlayer;
        this.turnCount += 1;
        this.cardsPlayedThisTurn = 0;
        this.selectedCard = -1;
        this.aiming = false;
        this.draggingCard = false;
        this.pressedCardIndex = -1;
        this.turnState = 'aim';
        this.resolveTimer = 0;
        this.tickTurnEffects();
        const drawn = this.drawTurnCards(this.currentPlayer);
        const prefix = reason ? `${reason} ` : '';
        this.message = `${prefix}轮到 ${this.fighters[this.currentPlayer].name}，抽 ${drawn} 张，手牌 ${this.currentHand().length}/${this.maxHandSize}。`;
    }

    private tickTurnEffects() {
        this.frictionTurns = Math.max(0, this.frictionTurns - 1);
        this.slopeTurns = Math.max(0, this.slopeTurns - 1);
        for (const fighter of this.fighters) {
            fighter.shieldTurns = Math.max(0, fighter.shieldTurns - 1);
            fighter.stabilityTurns = Math.max(0, fighter.stabilityTurns - 1);
            if (fighter.shieldTurns === 0) {
                fighter.shield = 0;
            }
            if (fighter.stabilityTurns === 0) {
                fighter.stability = 0;
            }
        }
    }

    private skipTurn() {
        const actor = this.fighters[this.currentPlayer];
        const played = this.cardsPlayedThisTurn;
        this.selectedCard = -1;
        this.aiming = false;
        this.draggingCard = false;
        this.pressedCardIndex = -1;
        const reason = played > 0
            ? `${actor.name} 结束回合，本回合共使用 ${played} 张卡。`
            : `${actor.name} 跳过回合。`;
        this.endTurn(reason);
    }

    private resolveCollision() {
        const a = this.fighters[0];
        const b = this.fighters[1];
        const dx = b.pos.x - a.pos.x;
        const dy = b.pos.y - a.pos.y;
        const dist = Math.max(0.001, Math.hypot(dx, dy));
        const minDist = a.radius + b.radius;
        if (dist >= minDist) {
            return;
        }

        const nx = dx / dist;
        const ny = dy / dist;
        const overlap = minDist - dist;
        a.pos.x -= nx * overlap * 0.5;
        a.pos.y -= ny * overlap * 0.5;
        b.pos.x += nx * overlap * 0.5;
        b.pos.y += ny * overlap * 0.5;

        const relX = b.vel.x - a.vel.x;
        const relY = b.vel.y - a.vel.y;
        const alongNormal = relX * nx + relY * ny;
        if (alongNormal > 0) {
            return;
        }

        const stableA = 1 + a.stability * 0.35 + a.shield * 0.25;
        const stableB = 1 + b.stability * 0.35 + b.shield * 0.25;
        const invMassA = 1 / (a.mass * stableA);
        const invMassB = 1 / (b.mass * stableB);
        const impulse = -(1.02 * alongNormal) / (invMassA + invMassB);
        a.vel.x -= impulse * invMassA * nx;
        a.vel.y -= impulse * invMassA * ny;
        b.vel.x += impulse * invMassB * nx;
        b.vel.y += impulse * invMassB * ny;
    }

    private checkRingOut() {
        for (let i = 0; i < this.fighters.length; i++) {
            const f = this.fighters[i];
            const out =
                f.pos.x < this.arena.x - this.ringOutMargin ||
                f.pos.x > this.arena.x + this.arena.w + this.ringOutMargin ||
                f.pos.y < this.arena.y - this.ringOutMargin ||
                f.pos.y > this.arena.y + this.arena.h + this.ringOutMargin;

            if (out) {
                const winner = 1 - i;
                this.fighters[winner].score += 1;
                if (this.fighters[winner].score >= 3) {
                    this.gameOver = true;
                    this.message = `${this.fighters[winner].name} 达到 3 分，获得胜利。点击右上角重开。`;
                } else {
                    this.resetRound(winner, `${this.fighters[i].name} 出界，${this.fighters[winner].name} 得 1 分。`);
                }
                break;
            }
        }
    }

    private onMouseDown(event: EventMouse) {
        const point = this.toLocalPoint(event);
        if (this.hitReset(point)) {
            this.resetMatch();
            return;
        }

        if (this.hitSkip(point)) {
            if (!this.gameOver && this.turnState === 'aim') {
                this.skipTurn();
            }
            return;
        }

        if (this.gameOver) {
            return;
        }

        if (this.turnState !== 'aim') {
            this.message = '物理结算中，结算完成后当前玩家可以继续出牌。';
            return;
        }

        const cardIndex = this.hitCard(point);
        if (cardIndex >= 0) {
            this.selectedCard = cardIndex;
            this.pressedCardIndex = cardIndex;
            this.draggingCard = false;
            this.aiming = false;
            this.pointerDownPoint.set(point.x, point.y);
            const card = this.currentHand()[cardIndex];
            this.setDefaultAimPoint();
            this.refreshSelectedCardInfo();
            this.message = `${card.name}: ${card.hint}`;
            return;
        }

        if (!this.gameOver && this.selectedCard >= 0 && this.inArena(point)) {
            this.draggingCard = false;
            this.aiming = true;
            this.aimPoint.set(point.x, point.y);
            this.refreshSelectedCardInfo();
        }
    }

    private onMouseMove(event: EventMouse) {
        const point = this.toLocalPoint(event);
        if (this.pressedCardIndex >= 0 && !this.draggingCard) {
            const dx = point.x - this.pointerDownPoint.x;
            const dy = point.y - this.pointerDownPoint.y;
            if (Math.hypot(dx, dy) >= this.dragStartThreshold) {
                this.draggingCard = true;
                this.aiming = true;
            }
        }
        if (!this.aiming) {
            return;
        }
        this.aimPoint.set(point.x, point.y);
        this.refreshSelectedCardInfo();
    }

    private onMouseUp(event: EventMouse) {
        if (this.pressedCardIndex >= 0 && !this.draggingCard) {
            this.aiming = false;
            this.draggingCard = false;
            this.pressedCardIndex = -1;
            const card = this.currentHand()[this.selectedCard];
            if (card) {
                this.refreshSelectedCardInfo();
                this.message = `${card.name}: 点击查看，拖拽到实验台内释放。`;
            }
            return;
        }

        if (!this.aiming || this.selectedCard < 0 || this.gameOver) {
            this.aiming = false;
            this.draggingCard = false;
            this.pressedCardIndex = -1;
            return;
        }
        if (this.turnState !== 'aim') {
            this.aiming = false;
            this.draggingCard = false;
            this.pressedCardIndex = -1;
            return;
        }
        const point = this.toLocalPoint(event);
        this.aimPoint.set(point.x, point.y);

        if (!this.inArena(point)) {
            const card = this.currentHand()[this.selectedCard];
            this.aiming = false;
            this.draggingCard = false;
            this.pressedCardIndex = -1;
            this.refreshSelectedCardInfo();
            this.message = card
                ? `${card.name}: 拖到实验台内释放，或点选后在场地内拖拽瞄准。`
                : '需要把卡牌拖到实验台内释放。';
            return;
        }

        this.playSelectedCard();
        this.aiming = false;
        this.draggingCard = false;
        this.pressedCardIndex = -1;
    }

    private playSelectedCard() {
        const playerIndex = this.currentPlayer;
        const cardIndex = this.selectedCard;
        const card = this.currentHand()[cardIndex];
        const actor = this.fighters[this.currentPlayer];
        const target = this.fighters[1 - this.currentPlayer];
        if (!card) {
            return;
        }
        const dir = this.aimDirection(actor, target);
        const dragScale = this.dragMultiplier(actor);
        this.dice = Math.floor(Math.random() * 6) + 1;
        const power = this.cardPower(card, this.dice, dragScale);
        const chargeAmount = this.chargeAmount(dragScale, this.dice);
        const duration = this.cardDuration(card, this.dice);

        switch (card.kind) {
            case 'impulse':
                this.addImpulse(actor, dir.x * power, dir.y * power);
                break;
            case 'reaction':
                actor.shield = Math.max(actor.shield, 2.2 + this.dice * 0.18 + dragScale * 0.4);
                actor.shieldTurns = Math.max(actor.shieldTurns, duration);
                actor.stability = Math.max(actor.stability, 1.3 + dragScale * 0.6);
                actor.stabilityTurns = Math.max(actor.stabilityTurns, duration);
                this.addImpulse(actor, -dir.x * power * 0.45, -dir.y * power * 0.45);
                break;
            case 'transfer': {
                const carryX = actor.vel.x;
                const carryY = actor.vel.y;
                actor.vel.x *= 0.35;
                actor.vel.y *= 0.35;
                this.addImpulse(target, carryX * 0.78 + dir.x * power * 0.58, carryY * 0.78 + dir.y * power * 0.58);
                break;
            }
            case 'brake':
                actor.vel.x *= 0.18;
                actor.vel.y *= 0.18;
                actor.stability = Math.max(actor.stability, 2.6 + this.dice * 0.16);
                actor.stabilityTurns = Math.max(actor.stabilityTurns, duration);
                break;
            case 'repel': {
                target.charge = this.clamp(target.charge + Math.sign(actor.charge || 1) * chargeAmount, -4, 4);
                this.addImpulse(target, dir.x * power, dir.y * power);
                this.addImpulse(actor, -dir.x * power * 0.16, -dir.y * power * 0.16);
                break;
            }
            case 'attract': {
                target.charge = this.clamp(target.charge - Math.sign(actor.charge || 1) * chargeAmount, -4, 4);
                this.addImpulse(target, dir.x * power, dir.y * power);
                this.addImpulse(actor, -dir.x * power * 0.14, -dir.y * power * 0.14);
                break;
            }
            case 'wall': {
                actor.shield = Math.max(actor.shield, 2.6 + this.dice * 0.18);
                actor.shieldTurns = Math.max(actor.shieldTurns, duration);
                actor.stability = Math.max(actor.stability, 2.8 + dragScale * 0.5);
                actor.stabilityTurns = Math.max(actor.stabilityTurns, duration);
                const side = new Vec2(-dir.y, dir.x);
                this.addImpulse(target, side.x * power * 0.55, side.y * power * 0.55);
                break;
            }
            case 'gyro':
                actor.vel.x *= 0.35;
                actor.vel.y *= 0.35;
                actor.stability = Math.max(actor.stability, 3.6 + this.dice * 0.18);
                actor.stabilityTurns = Math.max(actor.stabilityTurns, duration);
                actor.shield = Math.max(actor.shield, 1.4 + dragScale * 0.3);
                actor.shieldTurns = Math.max(actor.shieldTurns, Math.max(2, duration - 1));
                break;
            case 'zeroFriction':
                this.frictionTurns = Math.max(this.frictionTurns, duration);
                this.addImpulse(actor, dir.x * power * 0.45, dir.y * power * 0.45);
                this.addImpulse(target, dir.x * power * 0.28, dir.y * power * 0.28);
                break;
            case 'slope':
                this.slopeTurns = Math.max(this.slopeTurns, duration);
                this.slopeForce.set(dir.x * (38 + this.dice * 5) * dragScale, dir.y * (38 + this.dice * 5) * dragScale);
                break;
            case 'return': {
                const toCenter = this.directionBetween(actor.pos, new Vec2(0, 0));
                this.addImpulse(actor, toCenter.x * power, toCenter.y * power);
                actor.stability = Math.max(actor.stability, 1.2);
                actor.stabilityTurns = Math.max(actor.stabilityTurns, duration);
                break;
            }
            case 'chaos': {
                const a = Math.random() * Math.PI * 2;
                const b = Math.random() * Math.PI * 2;
                this.addImpulse(actor, Math.cos(a) * power * 0.75, Math.sin(a) * power * 0.75);
                this.addImpulse(target, Math.cos(b) * power * 0.55, Math.sin(b) * power * 0.55);
                break;
            }
        }

        this.consumePlayedCard(playerIndex, cardIndex);
        this.cardsPlayedThisTurn += 1;
        this.turnState = 'resolve';
        this.resolveTimer = 0;
        this.cardInfoText = this.cardDetails(card, power, dragScale, chargeAmount);
        this.message = `${actor.name} 打出第 ${this.cardsPlayedThisTurn} 张卡：${card.name}，骰子点数 ${this.dice}，有效力 ${Math.round(power)}。物理结算中...`;
        this.selectedCard = -1;
        this.draggingCard = false;
    }

    private addImpulse(fighter: Fighter, ix: number, iy: number) {
        const shieldDamp = 1 + fighter.shield * 0.08;
        fighter.vel.x += ix / fighter.mass / shieldDamp;
        fighter.vel.y += iy / fighter.mass / shieldDamp;
    }

    private diceMultiplier(dice: number) {
        return 0.7 + dice * 0.065;
    }

    private cardPower(card: CardDef, dice: number, dragScale: number) {
        return card.power * this.diceMultiplier(dice) * dragScale;
    }

    private dragMultiplier(actor: Fighter) {
        const distance = Math.hypot(this.aimPoint.x - actor.pos.x, this.aimPoint.y - actor.pos.y);
        return this.clamp(0.7 + Math.min(1, distance / 460) * 0.5, 0.7, 1.2);
    }

    private chargeAmount(dragScale: number, dice: number) {
        return this.clamp(0.35 + dragScale * 0.45 + dice * 0.06, 0.5, 1.25);
    }

    private setDefaultAimPoint() {
        const target = this.fighters[1 - this.currentPlayer];
        this.aimPoint.set(target.pos.x, target.pos.y);
    }

    private refreshSelectedCardInfo() {
        const card = this.currentHand()[this.selectedCard];
        if (!card) {
            return;
        }
        const actor = this.fighters[this.currentPlayer];
        this.cardInfoText = this.cardDetails(card, undefined, this.dragMultiplier(actor));
    }

    private cardDuration(card: CardDef, dice = this.dice) {
        switch (card.kind) {
            case 'reaction':
            case 'brake':
            case 'wall':
                return 2;
            case 'gyro':
                return 3;
            case 'zeroFriction':
            case 'slope':
                return 2 + (dice >= 5 ? 1 : 0);
            case 'return':
                return 2;
            default:
                return 0;
        }
    }

    private cardDurationText(card: CardDef) {
        switch (card.kind) {
            case 'zeroFriction':
            case 'slope':
                return '2 回合，骰子点数>=5 时 3 回合';
            case 'reaction':
            case 'brake':
            case 'wall':
            case 'return':
                return '2 回合';
            case 'gyro':
                return '3 回合';
            default:
                return '即时';
        }
    }

    private cardFormula(card: CardDef, chargeAmount?: number) {
        switch (card.kind) {
            case 'impulse':
                return '自身速度 += 有效力 / 质量，方向=拖拽方向';
            case 'reaction':
                return '护盾=2.2+骰子点数*0.18+拖拽倍率*0.4，稳定=1.3+拖拽倍率*0.6';
            case 'transfer':
                return '对手冲量=自身速度*0.78 + 拖拽方向*有效力*0.58';
            case 'brake':
                return '自身速度*=0.18，稳定=2.6+骰子点数*0.16';
            case 'repel':
                return `对手电荷 += ${chargeAmount ? chargeAmount.toFixed(2) : '0.50-1.25'}，对手沿拖拽方向受力`;
            case 'attract':
                return `对手电荷 -= ${chargeAmount ? chargeAmount.toFixed(2) : '0.50-1.25'}，对手沿拖拽方向受力`;
            case 'wall':
                return '护盾=2.6+骰子点数*0.18，稳定=2.8+拖拽倍率*0.5，侧向推力=有效力*0.55';
            case 'gyro':
                return '自身速度*=0.35，稳定=3.6+骰子点数*0.18，护盾=1.4+拖拽倍率*0.3';
            case 'zeroFriction':
                return '场地摩擦降低，双方沿拖拽方向受到轻推';
            case 'slope':
                return '场力方向=拖拽方向，场力强度=(38+骰子点数*5)*拖拽倍率';
            case 'return':
                return '自身朝实验台中心受力，并获得稳定 1.2';
            case 'chaos':
                return '双方受到随机方向扰动：自己*0.75，对手*0.55';
        }
    }

    private cardDetails(card: CardDef, appliedPower?: number, dragScale?: number, chargeAmount?: number) {
        const actor = this.fighters[this.currentPlayer];
        const target = this.fighters[1 - this.currentPlayer];
        const diceMin = this.diceMultiplier(1).toFixed(2);
        const diceMax = this.diceMultiplier(6).toFixed(2);
        const currentDragScale = dragScale !== undefined ? dragScale : this.dragMultiplier(actor);
        const dragText = currentDragScale.toFixed(2);
        const dir = this.aimDirection(actor, target);
        const direction = card.kind === 'return'
            ? this.directionBetween(actor.pos, new Vec2(0, 0))
            : dir;
        const directionText = card.kind === 'chaos'
            ? '方向：随机'
            : `方向 (${direction.x.toFixed(2)},${direction.y.toFixed(2)})`;
        const powerText = card.power > 0
            ? `基础力 ${card.power}，骰子倍率 ${diceMin}-${diceMax}，当前拖拽倍率 ${dragText}，${directionText}`
            : `无直接基础力，骰子倍率 ${diceMin}-${diceMax}，当前拖拽倍率 ${dragText}，${directionText}`;
        const durationText = `持续 ${this.cardDurationText(card)}`;
        const chargeText = card.kind === 'repel' || card.kind === 'attract'
            ? `，电荷改变量 ${chargeAmount !== undefined ? chargeAmount.toFixed(2) : '见点数表'}`
            : '';
        const actualText = appliedPower !== undefined
            ? card.power > 0
                ? `本次结算：骰子点数 ${this.dice}，有效力 ${Math.round(appliedPower)}${chargeText}`
                : `本次结算：骰子点数 ${this.dice}${chargeText}`
            : '预测：按当前方向和拖拽倍率，列出骰子点数 1 到 6 的结果';
        return [
            `${card.name}｜${card.hint}`,
            `${powerText}${chargeText}｜${durationText}`,
            actualText,
            this.cardOutcomeLine(card, currentDragScale, 1, 3),
            this.cardOutcomeLine(card, currentDragScale, 4, 6),
            `公式：${this.cardFormula(card, chargeAmount)}`,
        ].join('\n');
    }

    private cardOutcomeLine(card: CardDef, dragScale: number, fromDice: number, toDice: number) {
        const values: string[] = [];
        for (let dice = fromDice; dice <= toDice; dice++) {
            values.push(this.cardOutcomeText(card, dice, dragScale));
        }
        return values.join('  |  ');
    }

    private cardOutcomeText(card: CardDef, dice: number, dragScale: number) {
        const power = Math.round(this.cardPower(card, dice, dragScale));
        const duration = this.cardDuration(card, dice);
        const turns = duration > 0 ? `${duration}回` : '即时';
        switch (card.kind) {
            case 'impulse':
                return `点数${dice}: 力${power}`;
            case 'reaction':
                return `点数${dice}: 反冲${Math.round(power * 0.45)} 盾${(2.2 + dice * 0.18 + dragScale * 0.4).toFixed(1)} 稳${(1.3 + dragScale * 0.6).toFixed(1)} ${turns}`;
            case 'transfer':
                return `点数${dice}: 额外${Math.round(power * 0.58)}+速度78%`;
            case 'brake':
                return `点数${dice}: 速度*0.18 稳${(2.6 + dice * 0.16).toFixed(1)} ${turns}`;
            case 'repel':
                return `点数${dice}: 推${power} 电荷+${this.chargeAmount(dragScale, dice).toFixed(2)}`;
            case 'attract':
                return `点数${dice}: 拉${power} 电荷-${this.chargeAmount(dragScale, dice).toFixed(2)}`;
            case 'wall':
                return `点数${dice}: 侧推${Math.round(power * 0.55)} 盾${(2.6 + dice * 0.18).toFixed(1)} 稳${(2.8 + dragScale * 0.5).toFixed(1)} ${turns}`;
            case 'gyro':
                return `点数${dice}: 速度*0.35 稳${(3.6 + dice * 0.18).toFixed(1)} 盾${(1.4 + dragScale * 0.3).toFixed(1)} ${turns}`;
            case 'zeroFriction':
                return `点数${dice}: 己推${Math.round(power * 0.45)} 敌推${Math.round(power * 0.28)} ${turns}`;
            case 'slope':
                return `点数${dice}: 场力${Math.round((38 + dice * 5) * dragScale)} ${turns}`;
            case 'return':
                return `点数${dice}: 回场${power} 稳1.2 ${turns}`;
            case 'chaos':
                return `点数${dice}: 己扰${Math.round(power * 0.75)} 敌扰${Math.round(power * 0.55)}`;
        }
        return `点数${dice}: ${power}`;
    }

    private clamp(value: number, min: number, max: number) {
        return Math.max(min, Math.min(max, value));
    }

    private aimDirection(actor: Fighter, fallbackTarget: Fighter) {
        let dx = this.aimPoint.x - actor.pos.x;
        let dy = this.aimPoint.y - actor.pos.y;
        if (Math.hypot(dx, dy) < 18) {
            dx = fallbackTarget.pos.x - actor.pos.x;
            dy = fallbackTarget.pos.y - actor.pos.y;
        }
        const len = Math.max(0.001, Math.hypot(dx, dy));
        return new Vec2(dx / len, dy / len);
    }

    private directionBetween(from: Vec2, to: Vec2) {
        const dx = to.x - from.x;
        const dy = to.y - from.y;
        const len = Math.max(0.001, Math.hypot(dx, dy));
        return new Vec2(dx / len, dy / len);
    }

    private toLocalPoint(event: EventMouse) {
        const p = event.getUILocation();
        const local = this.canvas.convertToNodeSpaceAR(new Vec3(p.x, p.y, 0));
        return new Vec2(local.x, local.y);
    }

    private inArena(point: Vec2) {
        return point.x >= this.arena.x && point.x <= this.arena.x + this.arena.w && point.y >= this.arena.y && point.y <= this.arena.y + this.arena.h;
    }

    private hitCard(point: Vec2) {
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

    private hitSkip(point: Vec2) {
        const r = this.skipRect();
        return point.x >= r.x && point.x <= r.x + r.w && point.y >= r.y && point.y <= r.y + r.h;
    }

    private cardRect(index: number): RectLike {
        const total = this.maxHandSize * this.cardW + (this.maxHandSize - 1) * this.cardGap;
        return {
            x: -total / 2 + index * (this.cardW + this.cardGap),
            y: -336,
            w: this.cardW,
            h: this.cardH,
        };
    }

    private resetRect(): RectLike {
        return { x: 525, y: 292, w: 92, h: 38 };
    }

    private skipRect(): RectLike {
        return { x: 525, y: 246, w: 92, h: 38 };
    }

    private draw() {
        this.drawWorld();
        this.drawHud();
        this.updateLabels();
    }

    private drawWorld() {
        const g = this.worldG;
        g.clear();

        g.fillColor = new Color(12, 17, 24, 255);
        g.rect(-640, -360, 1280, 720);
        g.fill();

        g.fillColor = new Color(22, 30, 42, 255);
        g.rect(this.arena.x, this.arena.y, this.arena.w, this.arena.h);
        g.fill();

        g.strokeColor = new Color(99, 126, 160, 255);
        g.lineWidth = 3;
        g.rect(this.arena.x, this.arena.y, this.arena.w, this.arena.h);
        g.stroke();

        g.strokeColor = new Color(60, 81, 107, 255);
        g.lineWidth = 1;
        const gridStartX = Math.ceil(this.arena.x / 120) * 120;
        const gridEndX = this.arena.x + this.arena.w;
        const gridStartY = Math.ceil(this.arena.y / 90) * 90;
        const gridEndY = this.arena.y + this.arena.h;
        for (let x = gridStartX; x <= gridEndX; x += 120) {
            g.moveTo(x, this.arena.y);
            g.lineTo(x, this.arena.y + this.arena.h);
        }
        for (let y = gridStartY; y <= gridEndY; y += 90) {
            g.moveTo(this.arena.x, y);
            g.lineTo(this.arena.x + this.arena.w, y);
        }
        g.stroke();

        const ring = {
            x: this.arena.x - this.ringOutMargin,
            y: this.arena.y - this.ringOutMargin,
            w: this.arena.w + this.ringOutMargin * 2,
            h: this.arena.h + this.ringOutMargin * 2,
        };
        g.strokeColor = new Color(255, 118, 126, 86);
        g.lineWidth = 2;
        g.rect(ring.x, ring.y, ring.w, ring.h);
        g.stroke();

        if (this.slopeTurns > 0) {
            const dir = this.directionBetween(new Vec2(0, 0), this.slopeForce);
            g.strokeColor = new Color(132, 218, 255, 130);
            g.lineWidth = 4;
            for (let i = -3; i <= 3; i++) {
                const sx = i * 120 - dir.y * 36;
                const sy = i % 2 === 0 ? -110 : 110;
                g.moveTo(sx - dir.x * 28, sy - dir.y * 28);
                g.lineTo(sx + dir.x * 70, sy + dir.y * 70);
            }
            g.stroke();
        }

        for (let i = 0; i < this.fighters.length; i++) {
            this.drawFighter(g, this.fighters[i], i === this.currentPlayer);
        }

        if (this.aiming && this.selectedCard >= 0) {
            const actor = this.fighters[this.currentPlayer];
            g.strokeColor = new Color(255, 224, 115, 230);
            g.lineWidth = 4;
            g.moveTo(actor.pos.x, actor.pos.y);
            g.lineTo(this.aimPoint.x, this.aimPoint.y);
            g.stroke();

            g.fillColor = new Color(255, 224, 115, 230);
            g.circle(this.aimPoint.x, this.aimPoint.y, 7);
            g.fill();
        }
    }

    private drawFighter(g: Graphics, fighter: Fighter, active: boolean) {
        g.fillColor = new Color(0, 0, 0, 90);
        g.circle(fighter.pos.x + 5, fighter.pos.y - 7, fighter.radius + 3);
        g.fill();

        g.fillColor = fighter.color;
        g.circle(fighter.pos.x, fighter.pos.y, fighter.radius);
        g.fill();

        g.strokeColor = active ? new Color(255, 232, 125, 255) : new Color(230, 236, 246, 155);
        g.lineWidth = active ? 4 : 2;
        g.circle(fighter.pos.x, fighter.pos.y, fighter.radius + 2);
        g.stroke();

        if (fighter.shield > 0) {
            g.strokeColor = new Color(118, 225, 255, 170);
            g.lineWidth = 3;
            g.circle(fighter.pos.x, fighter.pos.y, fighter.radius + 10 + fighter.shield);
            g.stroke();
        }

        if (fighter.stability > 0) {
            g.strokeColor = new Color(165, 245, 163, 165);
            g.lineWidth = 2;
            g.circle(fighter.pos.x, fighter.pos.y, fighter.radius + 16 + fighter.stability);
            g.stroke();
        }

        const speed = Math.hypot(fighter.vel.x, fighter.vel.y);
        if (speed > 18) {
            const scale = Math.min(70, speed * 0.16);
            const vx = fighter.vel.x / speed;
            const vy = fighter.vel.y / speed;
            g.strokeColor = new Color(255, 255, 255, 135);
            g.lineWidth = 3;
            g.moveTo(fighter.pos.x, fighter.pos.y);
            g.lineTo(fighter.pos.x + vx * scale, fighter.pos.y + vy * scale);
            g.stroke();
        }
    }

    private drawHud() {
        const g = this.hudG;
        g.clear();

        g.fillColor = new Color(20, 27, 38, 238);
        g.rect(-640, 250, 1280, 110);
        g.fill();

        g.fillColor = new Color(15, 22, 32, 238);
        g.rect(-640, -360, 1280, 132);
        g.fill();

        this.drawPanel(g, -628, 198, 268, 92, new Color(24, 48, 75, 235), this.currentPlayer === 0);
        this.drawPanel(g, 360, 198, 268, 92, new Color(78, 31, 39, 235), this.currentPlayer === 1);

        const reset = this.resetRect();
        g.fillColor = new Color(48, 60, 76, 255);
        g.rect(reset.x, reset.y, reset.w, reset.h);
        g.fill();
        g.strokeColor = new Color(178, 193, 214, 255);
        g.lineWidth = 2;
        g.rect(reset.x, reset.y, reset.w, reset.h);
        g.stroke();

        const skip = this.skipRect();
        g.fillColor = this.turnState === 'aim' && !this.gameOver ? new Color(60, 69, 85, 255) : new Color(42, 47, 56, 255);
        g.rect(skip.x, skip.y, skip.w, skip.h);
        g.fill();
        g.strokeColor = this.turnState === 'aim' && !this.gameOver ? new Color(178, 193, 214, 255) : new Color(91, 103, 118, 255);
        g.lineWidth = 2;
        g.rect(skip.x, skip.y, skip.w, skip.h);
        g.stroke();

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
                g.strokeColor = this.inArena(this.aimPoint) ? new Color(255, 247, 209, 255) : new Color(255, 142, 142, 255);
                g.lineWidth = 3;
                g.rect(x, y, this.cardW, this.cardH);
                g.stroke();
            }
        }

        if (this.frictionTurns > 0) {
            g.fillColor = new Color(94, 229, 214, 55);
            g.rect(this.arena.x, this.arena.y, this.arena.w, this.arena.h);
            g.fill();
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

    private updateLabels() {
        const actor = this.fighters[this.currentPlayer];
        this.labels.title.string = '力学大乱斗 Cocos MVP';
        this.labels.turn.string = `第 ${this.turnCount} 回合 / 当前：${actor.name} / 已出 ${this.cardsPlayedThisTurn} 张`;
        this.labels.dice.string = `最近骰子：${this.dice}`;
        this.labels.message.string = this.message;
        this.labels.reset.string = '重开';
        this.labels.skip.string = this.cardsPlayedThisTurn > 0 ? '结束' : '跳过';
        this.labels.skip.color = this.turnState === 'aim' && !this.gameOver ? new Color(238, 244, 255, 255) : new Color(142, 154, 170, 255);
        this.labels.p0.string = this.playerText(0);
        this.labels.p1.string = this.playerText(1);
        this.labels.cardInfo.string = this.cardInfoText || '单击卡牌查看基础数值、公式和持续回合；拖拽卡牌到实验台内释放。';
        const selected = this.currentHand()[this.selectedCard];
        this.labels.hint.string = this.turnState === 'resolve'
            ? `结算阶段：等待速度降到阈值，或 ${Math.max(0, this.maxResolveTime - this.resolveTimer).toFixed(1)} 秒后继续由 ${actor.name} 出牌。`
            : selected
                ? `已选：${selected.name}。打出后会消耗；本回合可继续出牌，也可以点${this.cardsPlayedThisTurn > 0 ? '结束' : '跳过'}交给对手。`
                : `${actor.name} 手牌 ${this.currentHand().length}/${this.maxHandSize}。本回合已出 ${this.cardsPlayedThisTurn} 张；可连续出牌，点${this.cardsPlayedThisTurn > 0 ? '结束' : '跳过'}换人。`;
        this.labels.field.string = this.fieldText();

        const resetLabel = this.labels.message;
        const hand = this.currentHand();
        for (let i = 0; i < this.cardLabels.length; i++) {
            const card = hand[i];
            this.cardLabels[i].string = card ? `${i + 1}\n${card.shortName}` : '';
            this.cardLabels[i].color = i === this.selectedCard ? new Color(32, 27, 18, 255) : new Color(238, 242, 249, 255);
        }

        resetLabel.node.setSiblingIndex(this.node.children.length - 1);
    }

    private playerText(index: number) {
        const p = this.fighters[index];
        const speed = Math.round(Math.hypot(p.vel.x, p.vel.y));
        const state = [];
        if (p.shield > 0) {
            state.push(`盾 ${p.shield.toFixed(1)}(${p.shieldTurns}回合)`);
        }
        if (p.stability > 0) {
            state.push(`稳 ${p.stability.toFixed(1)}(${p.stabilityTurns}回合)`);
        }
        const handCount = this.hands[index]?.length || 0;
        return `${p.name}  ${p.score}分  手牌 ${handCount}/${this.maxHandSize}\n位置 (${Math.round(p.pos.x)},${Math.round(p.pos.y)})  半径 ${p.radius}\n速度 (${Math.round(p.vel.x)},${Math.round(p.vel.y)})=${speed}  质量 ${p.mass}\n电荷 ${p.charge.toFixed(2)}  ${state.length ? state.join(' / ') : '状态：常规'}`;
    }

    private fieldText() {
        const effects = [];
        if (this.frictionTurns > 0) {
            effects.push(`摩擦归零 ${this.frictionTurns}回合`);
        }
        if (this.slopeTurns > 0) {
            effects.push(`冰面斜坡 ${this.slopeTurns}回合 场力(${Math.round(this.slopeForce.x)},${Math.round(this.slopeForce.y)})`);
        }
        const friction = this.frictionTurns > 0 ? '0.991/帧' : '0.976/帧';
        return `实验台 ${this.arena.w}x${this.arena.h}，出界缓冲 ${this.ringOutMargin}，摩擦 ${friction}，场效果：${effects.length ? effects.join('；') : '无'}`;
    }
}
